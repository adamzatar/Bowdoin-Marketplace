// apps/web/app/api/admin/listings/[id]/remove/route.ts

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { prisma } from '@bowdoin/db';
import { logger } from '@bowdoin/observability/logger';
import { getRedisClient } from '@bowdoin/rate-limit/redisClient';
import { consume as consumeTokenBucket } from '@bowdoin/rate-limit/tokenBucket';
import { z } from 'zod';

// Local app helpers (avoid next-auth & next/headers)
import { auditEvent } from '../../../../../../src/server/handlers/audit';
import { requireSession } from '../../../../../../src/server/withAuth';

const JSON_NOSTORE: HeadersInit = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

const IdParam = z.object({ id: z.string().uuid('invalid id') });
const BodyZ = z
  .object({
    reason: z.string().min(3).max(500).optional(),
    permanent: z.boolean().default(false).optional(),
  })
  .strict();

function jsonError(status: number, code: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error: code, ...(extra ?? {}) }, null, 0), {
    status,
    headers: JSON_NOSTORE,
  });
}

/** Runtime-safe guard for admin-like privileges coming from session.user. */
function isAdminish(u: unknown): boolean {
  if (!u || typeof u !== 'object') return false;

  const role = (u as { role?: unknown }).role;
  if (role === 'admin') return true;

  const roles = (u as { roles?: unknown }).roles;
  if (Array.isArray(roles) && roles.includes('admin')) return true;

  const perms = (u as { permissions?: unknown }).permissions;
  if (Array.isArray(perms)) {
    return perms.includes('admin:read') || perms.includes('admin:write');
  }
  return false;
}

/** Local, package-based rate limiter (no app-internal imports). */
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
    // Infra failures: soft-allow, but propagate explicit rate_limited
    logger.warn({ key, limit, windowSec, err }, 'rate limit unavailable or exceeded');
    if ((err as Error).message === 'rate_limited') throw err;
  }
}

function getIpFrom(req: Request): string {
  const xfwd = req.headers.get('x-forwarded-for');
  if (xfwd) {
    const first = xfwd.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return '0.0.0.0';
}

export async function POST(req: Request, ctx: { params: { id: string } }): Promise<Response> {
  // Authn + admin gate via shared helper
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const session = auth.session;
  const user = session?.user;
  const userId = typeof user?.id === 'string' ? user.id : null;

  if (!userId) return jsonError(401, 'unauthorized');
  if (!isAdminish(user)) return jsonError(403, 'forbidden');

  const ip = getIpFrom(req);
  const ua = req.headers.get('user-agent') ?? undefined;

  // Per-user + per-IP limits
  try {
    await Promise.all([
      rateLimit(`admin:listing:remove:user:${userId}`, 30, 60),
      rateLimit(`admin:listing:remove:ip:${ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  const parsedId = IdParam.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_listing_id');
  const listingId = parsedId.data.id;

  const parsedBody = BodyZ.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) return jsonError(400, 'invalid_request_body');
  const body = parsedBody.data;

  try {
    const deleted = await prisma.listing.delete({
      where: { id: listingId },
      select: { id: true, title: true },
    });

    // Mirror existing audit logging shape, but use local emitter
    void auditEvent.emit(
      'admin.listing.remove',
      {
        outcome: 'success',
        meta: {
          actorId: userId,
          subjectId: deleted.id,
          reason: body.reason ?? undefined,
          ip,
          ua,
          mode: 'hard',
        },
      },
      // optional ctx bag your emitter accepts elsewhere
      { req, userId },
    );

    return new Response(
      JSON.stringify({ ok: true, listingId: deleted.id, removed: true, permanent: true }, null, 0),
      { status: 200, headers: JSON_NOSTORE },
    );
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'P2025') return jsonError(404, 'listing_not_found');

    logger.error({ err: e, listingId }, 'admin.listing.remove error');

    // Emit failure audit as in other routes
    void auditEvent.emit(
      'admin.listing.remove',
      {
        outcome: 'failure',
        meta: {
          actorId: userId,
          subjectId: listingId,
          reason: body.reason ?? undefined,
          ip,
          ua,
          mode: 'hard',
        },
      },
      { req, userId },
    );

    return jsonError(500, 'internal_error');
  }
}