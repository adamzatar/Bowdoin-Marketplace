// apps/web/app/api/users/verification/request/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import process from 'node:process';
import { env } from '@bowdoin/config/env';
import { audit } from '@bowdoin/observability/audit';
import { logger } from '@bowdoin/observability/logger';
import { getRedisClient } from '@bowdoin/rate-limit/redisClient';
import { consume as consumeTokenBucket } from '@bowdoin/rate-limit/tokenBucket';
import { authOptions } from '@bowdoin/auth/nextauth';
import { headers } from 'next/headers';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import type { NextRequest } from 'next/server';

const BodySchema = z
  .object({
    email: z.string().trim().email('must be a valid email address'),
  })
  .strict();

type SessionUserWithId = {
  id: string;
} & Record<string, unknown>;

function hasUserId(user: { id?: unknown } | null | undefined): user is SessionUserWithId {
  return typeof user?.id === 'string' && user.id.length > 0;
}

function jsonError(status: number, code: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error: code, ...(extra ?? {}) }, null, 0), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
      expires: '0',
      vary: 'Cookie',
    },
  });
}

function parseAllowDomains(): string[] {
  const raw = process.env.ALLOW_VERIFICATION_DOMAINS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedDomain(email: string, allow: string[]): boolean {
  if (allow.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && allow.some((d) => d === domain || domain.endsWith(`.${d}`));
}

function parseTokenTtlSeconds(): number {
  const raw = process.env.EMAIL_TOKEN_TTL_SECONDS;
  const n = raw ? Number(raw) : NaN;
  const ttl = Number.isFinite(n) && n > 0 ? Math.min(n, 60 * 60) : 15 * 60;
  return Math.max(60, ttl);
}

function appBaseUrl(): string {
  const base = (env as unknown as Record<string, string | undefined>).APP_URL;
  const fallback = env.NEXTAUTH_URL;
  return (base ?? fallback ?? 'http://localhost:3000').replace(/\/+$/, '');
}

function ipFromHeaders(h: Headers): string {
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return h.get('x-real-ip') ?? '0.0.0.0';
}

async function rateLimit(key: string, limit: number, windowSec: number): Promise<void> {
  try {
    const client = await getRedisClient();
    const res = await consumeTokenBucket(
      {
        key,
        capacity: limit,
        refillAmount: limit,
        refillIntervalMs: windowSec * 1000,
        namespace: 'rl:web',
        client,
      },
      1,
    );
    if (!res.allowed) throw new Error('rate_limited');
  } catch (err) {
    // If Redis or limiter isn’t available, log and allow (don’t 500 user flows).
    logger.warn({ key, limit, windowSec, err }, 'rate limit unavailable or exceeded');
    if ((err as Error).message === 'rate_limited') throw err;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await getServerSession(authOptions);
  const user = session?.user;
  if (!hasUserId(user)) return jsonError(401, 'unauthorized');
  const userId = user.id;

  const hdrs = headers();
  const ip = ipFromHeaders(hdrs);

  try {
    await Promise.all([
      rateLimit(`users:verification:request:user:${userId}`, 5, 60),
      rateLimit(`users:verification:request:ip:${ip}`, 30, 60),
    ]);
  } catch {
    return jsonError(429, 'rate_limited', { retryAfterSec: 60 });
  }

  const json = (await req.json()) as unknown;
  const parsedBody = BodySchema.safeParse(json);
  if (!parsedBody.success) {
    const issues = parsedBody.error.errors as Array<{ message: string }>;
    const message = issues.map((issue) => issue.message).join('; ');
    return jsonError(400, 'bad_request', { message });
  }
  const body = parsedBody.data;

  const allow = parseAllowDomains();
  if (!isAllowedDomain(body.email, allow)) {
    return jsonError(400, 'email_domain_not_allowed');
  }

  // — Token issuance (via @bowdoin/auth/utils/email-token-store) —
  // We import types via an ambient d.ts (see step #2) to satisfy DTS.
  const { EmailTokenStore } = await import('@bowdoin/auth/utils/email-token-store');
  const store = new EmailTokenStore();
  const ttlSeconds = parseTokenTtlSeconds();
  type TokenCreateResult = {
    token: string;
    expiresAt: Date | number | string;
  };

  const { token, expiresAt } = (await store.create({
    userId,
    email: body.email,
    ttlSeconds,
  })) as TokenCreateResult;

  const expDate =
    expiresAt instanceof Date
      ? expiresAt
      : new Date(typeof expiresAt === 'number' ? expiresAt * 1000 : Date.parse(String(expiresAt)));

  try {
    const { sendVerificationEmail } = await import('@bowdoin/email/sendVerificationEmail');
    await sendVerificationEmail({
      to: body.email,
      token,
      verifyBaseUrl: `${appBaseUrl()}/api/users/verification/confirm`,
      affiliation: 'community',
    });

    void audit.emit('user.verification.requested', {
      outcome: 'success',
      meta: {
        actorId: userId,
        email: body.email,
        expiresAt: expDate.toISOString(),
        ip,
        ua: hdrs.get('user-agent') ?? undefined,
      },
    });
  } catch (err) {
    void audit.emit('email.send.failed', {
      outcome: 'failure',
      severity: 'warn',
      meta: {
        actorId: userId,
        email: body.email,
        reason: 'verification_dispatch_failed',
        error: err instanceof Error ? err.message : String(err),
        ip,
        ua: hdrs.get('user-agent') ?? undefined,
      },
    });
    return jsonError(502, 'email_send_failed');
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        email: body.email,
        expiresAt: expDate.toISOString(),
        message: 'If the address is eligible, a verification email has been sent.',
      },
      null,
      0,
    ),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate, private',
        pragma: 'no-cache',
        expires: '0',
        vary: 'Cookie',
      },
    },
  );
}
