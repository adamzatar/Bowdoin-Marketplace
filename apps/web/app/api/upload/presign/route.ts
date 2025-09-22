// apps/web/app/api/upload/presign/route.ts
//
// Generate a short-lived S3 POST policy for direct-to-bucket uploads.
// - Auth required
// - Validates filename, content type and size
// - Strong, collision-resistant object key with per-user prefix
// - Least-privilege policy (content-length-range + exact content-type)
// - AWS Signature V4 (POST form) with 5 min TTL
// - Returns fields compatible with <input type="file">/FormData direct upload
//
// Assumes AWS creds + bucket config are provided via @bowdoin/config env.
// If you have a helper in @bowdoin/storage, you can swap the signer below
// to call that instead; this version is self-contained and production-safe.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { randomUUID, createHmac } from 'node:crypto';

import { env } from '@bowdoin/config/env';
import { Upload } from '@bowdoin/contracts/schemas/upload';
import { z } from 'zod';

import { auditEvent } from '../../../../src/server/handlers/audit';
import { jsonError } from '../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../src/server/rateLimit';
import { withAuth } from '../../../../src/server/withAuth';

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// ------- Input validation

const BodyZ = z.object({
  filename: z.string().min(1).max(256),
  contentType: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[\w.+-]+\/[\w.+-]+$/i, 'invalid content type'),
  size: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 25), // hard cap 25MB
  checksum: z.string().optional(), // client may send MD5 (base64) or sha256 (hex); we don't enforce at presign step
  // optional audience/visibility flags you may enforce later when persisting the object key
  audience: z.enum(['public', 'campus']).optional(),
});

// Max size per upload; can be lowered by callers
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TTL_SECONDS = 5 * 60; // 5 minutes

// ------- Tiny helpers

function dateStamp(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function amzDatetime(d: Date) {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function safeFilename(name: string) {
  // drop directory hints, collapse spaces, keep extension
  const base = name.split('/').pop()!.split('\\').pop()!;
  return base
    .replace(/[^\w.+-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 128);
}

function buildObjectKey(userId: string, filename: string) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const id = randomUUID();
  const file = safeFilename(filename);
  return `uploads/${userId}/${yyyy}/${mm}/${dd}/${id}-${file}`;
}

// ------- AWS SigV4 for S3 POST policies

type PresignInput = {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  key: string;
  contentType: string;
  maxSize: number;
  ttlSeconds: number; // <= 900
  acl?: 'private' | 'public-read';
};

function hmac(key: Buffer | string, data: string) {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function awsSigningKey(secret: string, date: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function base64(input: unknown) {
  return Buffer.from(JSON.stringify(input)).toString('base64');
}

function presignS3Post(input: PresignInput) {
  const now = new Date();
  const xAmzDate = amzDatetime(now); // e.g. 20250904T123456Z
  const shortDate = dateStamp(now); // e.g. 20250904
  const credential = `${input.accessKeyId}/${shortDate}/${input.region}/s3/aws4_request`;
  const algorithm = 'AWS4-HMAC-SHA256';
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

  // Conditions: exact bucket, exact key, exact content-type, size limit, and required AWS fields
  const conditions: unknown[] = [
    { bucket: input.bucket },
    { key: input.key },
    { 'Content-Type': input.contentType },
    ['content-length-range', 1, input.maxSize],
    { 'x-amz-date': xAmzDate },
    { 'x-amz-algorithm': algorithm },
    { 'x-amz-credential': credential },
  ];

  if (input.sessionToken) {
    conditions.push({ 'x-amz-security-token': input.sessionToken });
  }
  if (input.acl) {
    conditions.push({ acl: input.acl });
  }

  const policy = {
    expiration: expiresAt.toISOString(),
    conditions,
  };

  const policyB64 = base64(policy);
  const signingKey = awsSigningKey(input.secretAccessKey, shortDate, input.region, 's3');
  const signature = createHmac('sha256', signingKey).update(policyB64).digest('hex');

  const fields: Record<string, string> = {
    key: input.key,
    'Content-Type': input.contentType,
    'x-amz-algorithm': algorithm,
    'x-amz-credential': credential,
    'x-amz-date': xAmzDate,
    policy: policyB64,
    'x-amz-signature': signature,
  };
  if (input.sessionToken) fields['x-amz-security-token'] = input.sessionToken;
  if (input.acl) fields['acl'] = input.acl;

  // public endpoint works cross-region; you can swap to virtual-hosted if desired
  const url = `https://${input.bucket}.s3.${input.region}.amazonaws.com`;

  return { url, fields, expiresAt };
}

// ------- Route handler

export const POST = withAuth(async (req, ctx) => {
  // 1) Rate limit (per-user + per-IP)
  try {
    await Promise.all([
      rateLimit(`rl:upload:presign:user:${ctx.session.user.id}`, 20, 60), // 20/min/user
      rateLimit(`rl:upload:presign:ip:${ctx.ip}`, 60, 60), // 60/min/ip
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // 2) Parse body
  let body: z.infer<typeof BodyZ>;
  try {
    body = BodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_request_body');
  }

  // 3) Env / config (adjust these to your env loader)
  const region = env.AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const bucket = env.S3_BUCKET || process.env.S3_BUCKET || '';
  const accessKeyId = env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  const sessionToken = env.AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN || undefined;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return jsonError(500, 'upload_not_configured');
  }

  // 4) Compute constraints & object key
  const maxSize = Math.min(body.size, DEFAULT_MAX_SIZE);
  const key = buildObjectKey(ctx.session.user.id, body.filename);
  const ttlSeconds = Math.min(MAX_TTL_SECONDS, 5 * 60); // enforce 5 min max

  // 5) Create POST policy (SigV4)
  const { url, fields, expiresAt } = presignS3Post({
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    key,
    contentType: body.contentType,
    maxSize,
    ttlSeconds,
    // If you serve images publicly from S3/CloudFront, set public-read. Otherwise keep private.
    acl: 'private',
  });

  const response: Upload.PresignResponse = {
    ok: true,
    upload: {
      url,
      fields,
      key,
      contentType: body.contentType,
      maxSize,
      expiresIn: Math.floor((+expiresAt - Date.now()) / 1000),
    },
  };

  // Optional: validate against contract in non-prod
  if (process.env.NODE_ENV !== 'production') {
    try {
      Upload.PresignResponseZ.parse(response);
    } catch {
      // don't crash runtime; CI should catch drift
    }
  }

  // 6) Audit (fire-and-forget)
  auditEvent('upload.presign.created', {
    actorId: ctx.session.user.id,
    key,
    contentType: body.contentType,
    size: body.size,
    ip: ctx.ip,
  }).catch(() => {});

  return new Response(JSON.stringify(response), { status: 200, headers: JSON_NOSTORE });
});
