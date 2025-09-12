// apps/web/app/api/admin/listings/[id]/remove/route.ts

import { prisma } from '@bowdoin/db';
import { audit } from '@bowdoin/observability/audit';
import { logger } from '@bowdoin/observability/logger';
import { getRedisClient } from '@bowdoin/rate-limit/redisClient';
import { consume as consumeTokenBucket } from '@bowdoin/rate-limit/tokenBucket';
import { authOptions } from '@bowdoin/auth/nextauth';
import { headers } from 'next/headers';
import { getServerSession } from 'next-auth';
import { z } from 'zod';

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

type Adminish =
  | { role?: string | null; roles?: string[] | null; permissions?: string[] | null }
  | undefined
  | null;

function isAdminish(u: Adminish): boolean {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (Array.isArray(u.roles) && u.roles.includes('admin')) return true;
  if (Array.isArray(u.permissions)) {
    return u.permissions.includes('admin:read') || u.permissions.includes('admin:write');
  }
  return false;
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
    logger.warn({ key, limit, windowSec, err }, 'rate limit unavailable or exceeded');
    if ((err as Error).message === 'rate_limited') throw err;
  }
}

export async function POST(
  req: Request,
  ctx: { params: { id: string } },
): Promise<Response> {
  const session = await getServerSession(authOptions);
  const user = session?.user;
  if (!user?.id) return jsonError(401, 'unauthorized');
  if (!isAdminish(user)) return jsonError(403, 'forbidden');

  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    hdrs.get('x-real-ip') ??
    '0.0.0.0';

  try {
    await Promise.all([
      rateLimit(`admin:listing:remove:user:${user.id}`, 30, 60),
      rateLimit(`admin:listing:remove:ip:${ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  let listingId: string;
  try {
    listingId = IdParam.parse(ctx.params).id;
  } catch {
    return jsonError(400, 'invalid_listing_id');
  }

  let body: z.infer<typeof BodyZ>;
  try {
    body = BodyZ.parse(await req.json().catch(() => ({})));
  } catch {
    return jsonError(400, 'invalid_request_body');
  }

  try {
    const deleted = await prisma.listing.delete({
      where: { id: listingId },
      select: { id: true },
    });

    void audit.emit('admin.listing.remove', {
      outcome: 'success',
      meta: {
        actorId: user.id,
        subjectId: deleted.id,
        reason: body.reason ?? undefined,
        ip,
        ua: hdrs.get('user-agent') ?? undefined,
        mode: 'hard',
      },
    });

    return new Response(
      JSON.stringify({ ok: true, listingId: deleted.id, removed: true, permanent: true }, null, 0),
      { status: 200, headers: JSON_NOSTORE },
    );
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'P2025') return jsonError(404, 'listing_not_found');
    logger.error({ err: e, listingId }, 'admin.listing.remove error');
    return jsonError(500, 'internal_error');
  }
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;