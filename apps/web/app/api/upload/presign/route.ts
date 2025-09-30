// apps/web/app/api/upload/presign/route.ts
//
// POST: generate a short-lived S3 pre-signed PUT URL for authenticated users
// - Auth required
// - Rate limited per user + per IP
// - Validates filename/contentType/maxBytes
// - No contracts dependency; local Zod schemas

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import { env } from '@bowdoin/config/env';
import { z } from 'zod';
import { withAuth, rateLimit, auditEvent, jsonError } from '@/server';

// ----- Zod

const BodyZ = z.object({
  filename: z.string().min(1).max(256),
  contentType: z.string().min(3).max(128),
  maxBytes: z.number().int().positive().max(25 * 1024 * 1024), // 25MB cap
});

const PresignRespZ = z.object({
  ok: z.literal(true),
  data: z.object({
    url: z.string().url(),
    fields: z.record(z.string()),
    key: z.string(),
    bucket: z.string(),
    contentType: z.string(),
    expiresIn: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
  }),
});

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
} as const;

function getClientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for');
  if (xf) {
    const first = xf.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? '0.0.0.0';
}

// ----- Helpers

function randomKey(prefix: string) {
  const rand = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  return `${prefix}/${ts}-${rand}`;
}

function base64url(buf: Buffer) {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

// Per AWS S3 POST policy (V4)
function buildS3Policy({
  bucket,
  key,
  contentType,
  maxBytes,
  region: _region,
  expiresInSec,
  dateISO8601: _dateISO8601,
  credential,
  algorithm,
  amzDate,
}: {
  bucket: string;
  key: string;
  contentType: string;
  maxBytes: number;
  region: string;
  expiresInSec: number;
  dateISO8601: string; // yyyymmdd
  credential: string;
  algorithm: string;
  amzDate: string; // yyyymmdd'T'HHMMSS'Z'
}) {
  const expiration = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const conditions = [
    { bucket },
    ['starts-with', '$key', key],
    { acl: 'private' },
    { 'Content-Type': contentType },
    ['content-length-range', 0, maxBytes],
    { 'x-amz-credential': credential },
    { 'x-amz-algorithm': algorithm },
    { 'x-amz-date': amzDate },
  ];
  const policy = { expiration, conditions };
  const policyBase64 = base64url(Buffer.from(JSON.stringify(policy)));
  return policyBase64;
}

function hmac(key: Buffer | string, data: string) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function getSigningKey(secret: string, dateISO8601: string, region: string, service = 's3') {
  const kDate = hmac(`AWS4${secret}`, dateISO8601);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

function sign(policyBase64: string, signingKey: Buffer) {
  return Buffer.from(crypto.createHmac('sha256', signingKey).update(policyBase64).digest('hex')).toString('hex');
}

// ----- POST /api/upload/presign

export const POST = withAuth()(async (req, ctx) => {
  const viewerId = ctx.session?.user?.id ?? ctx.userId;
  if (!viewerId) return jsonError(401, 'unauthorized');

  const ip = getClientIp(req);

  try {
    await Promise.all([
      rateLimit(`rl:upload:presign:user:${viewerId}`, 60, 60),
      rateLimit(`rl:upload:presign:ip:${ip}`, 120, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const parsedBody = BodyZ.safeParse(await req.json());
  if (!parsedBody.success) {
    return jsonError(400, 'invalid_body');
  }
  const body = parsedBody.data;

  const region = env.S3_REGION ?? 'us-east-1';
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    return jsonError(500, 's3_not_configured');
  }

  const folder = `users/${viewerId}`;
  const keyPrefix = randomKey(folder);
  const safeFilename = body.filename.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  const key = `${keyPrefix}-${safeFilename}`;

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const dateISO8601 = `${y}${m}${d}`;
  const amzDate = `${dateISO8601}T${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(
    2,
    '0',
  )}${String(now.getUTCSeconds()).padStart(2, '0')}Z`;
  const algorithm = 'AWS4-HMAC-SHA256';
  const credential = `${accessKeyId}/${dateISO8601}/${region}/s3/aws4_request`;

  const expiresInSec = 60;
  const policyBase64 = buildS3Policy({
    bucket,
    key,
    contentType: body.contentType,
    maxBytes: body.maxBytes,
    region,
    expiresInSec,
    dateISO8601,
    credential,
    algorithm,
    amzDate,
  });

  const signingKey = getSigningKey(secretAccessKey, dateISO8601, region);
  const signature = sign(policyBase64, signingKey);

  const formFields = {
    key,
    bucket,
    acl: 'private',
    'Content-Type': body.contentType,
    'x-amz-algorithm': algorithm,
    'x-amz-credential': credential,
    'x-amz-date': amzDate,
    Policy: policyBase64,
    'X-Amz-Signature': signature,
  };

  await auditEvent('upload.presign', {
    actor: { id: viewerId },
    target: { type: 's3', id: bucket },
    meta: { region, keyPrefix: keyPrefix.slice(0, 64), contentType: body.contentType, maxBytes: body.maxBytes },
    req: { ip, route: '/api/upload/presign' },
    outcome: 'success',
  });

  const resp = {
    ok: true,
    data: {
      url: `https://${bucket}.s3.${region}.amazonaws.com/`,
      fields: formFields,
      key,
      bucket,
      contentType: body.contentType,
      expiresIn: expiresInSec,
      maxBytes: body.maxBytes,
    },
  };

  if (env.NODE_ENV !== 'production') {
    try {
      PresignRespZ.parse(resp);
    } catch {
      // dev-only guard; ignore parsing issues at runtime
    }
  }

  return new Response(JSON.stringify(resp), { status: 200, headers: noStoreHeaders });
});
