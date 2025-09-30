// apps/web/app/api/users/verification/confirm/route.ts
//
// Confirms a community verification token.
// - Accepts ?token=... (preferred) or JSON { token }
// - Single-use tokens (EmailTokenStore.consume)
// - Marks user as community-verified in DB
// - Emits audit events; rate-limits attempts; no-store caching

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { EmailTokenStore } from '@bowdoin/auth/utils/email-token-store';
import { flags } from '@bowdoin/config/flags';
import { prisma } from '@bowdoin/db';
import { Affiliation } from '@prisma/client';
import { headers } from 'next/headers';
import { z } from 'zod';

import { withAuth, rateLimit, auditEvent, jsonError } from '@/server';

function noStore() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate, private',
    pragma: 'no-cache',
    expires: '0',
    vary: 'Cookie',
  };
}

const Body = z.object({ token: z.string().min(16) }).strict();

type VerificationTokenPayload = {
  userId: string;
  email: string;
  purpose: string;
  issuedAt: number;
  expiresAt: number;
};

type ConsumableEmailTokenStore = InstanceType<typeof EmailTokenStore> & {
  consume: (token: string) => Promise<VerificationTokenPayload>;
};

export const POST = withAuth()(async (req, ctx) => {
  const session = ctx.session;
  const user = session?.user;
  const userId = ctx.userId ?? user?.id;
  if (!userId) return jsonError(401, 'unauthorized');

  // Rate limit confirmations per-user (burst-friendly)
  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || '0.0.0.0';
  try {
    await rateLimit(`users:verification:confirm:${userId}`, 10, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Extract token from query first, then body
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('token');
  let token = queryToken ?? null;
  if (!token) {
    try {
      const body = Body.parse(await req.json());
      token = body.token;
    } catch {
      return jsonError(400, 'token is required');
    }
  }

  // Validate & consume token
  const store = new EmailTokenStore() as ConsumableEmailTokenStore;
  let payload: VerificationTokenPayload | null = null;

  try {
    payload = await store.consume(token!); // single-use
  } catch (err) {
    // consume throws for invalid/expired/already-used
    auditEvent('user.verification.confirm.failed', {
      actor: { type: 'user', id: userId },
      reason: err instanceof Error ? err.message : String(err),
      ip,
      ua: hdrs.get('user-agent') ?? undefined,
    }).catch(() => {});
    return jsonError(400, 'invalid or expired token');
  }

  // Purpose check & user ownership
  if (!payload || payload.purpose !== 'community-verify') {
    return jsonError(400, 'invalid token purpose');
  }
  if (payload.userId !== userId) {
    // Don’t leak anything; also do not restore the token.
    auditEvent('user.verification.confirm.denied', {
      actor: { type: 'user', id: userId },
      attemptedFor: payload.userId,
      ip,
      ua: hdrs.get('user-agent') ?? undefined,
    }).catch(() => {});
    return jsonError(403, 'token does not belong to this user');
  }

  // Persist verification
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        affiliation: Affiliation.COMMUNITY,
        communityVerifiedAt: new Date(),
      },
    });
  } catch (err) {
    // On DB failure, we do NOT re-credit the token (still single-use)
    auditEvent('user.verification.persist.failed', {
      actor: { type: 'user', id: userId },
      error: err instanceof Error ? err.message : String(err),
      ip,
      ua: hdrs.get('user-agent') ?? undefined,
    }).catch(() => {});
    return jsonError(500, 'failed to persist verification');
  }

  // Optional: short cooldown to prevent spam confirms
  if (flags.VERIFY_CONFIRM_DELAY_MS && flags.VERIFY_CONFIRM_DELAY_MS > 0) {
    await new Promise((r) => setTimeout(r, flags.VERIFY_CONFIRM_DELAY_MS));
  }

  // Audit success
  auditEvent('user.verified', {
    actor: { type: 'user', id: userId },
    email: payload.email,
    method: 'email',
    ip,
    ua: hdrs.get('user-agent') ?? undefined,
  }).catch(() => {});

  return new Response(
    JSON.stringify({
      ok: true,
      userId,
      email: payload.email,
      verified: true,
    }),
    { status: 200, headers: noStore() },
  );
});
