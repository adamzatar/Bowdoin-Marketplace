// apps/web/app/api/admin/users/[id]/ban/route.ts
export const runtime = 'nodejs';

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { withAuth, rateLimit, auditEvent, jsonError, idParam } from '@/server';

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// Treat any of these shapes as “admin”
function isAdminish(u: unknown): u is {
  role?: string;
  roles?: string[];
  permissions?: string[];
} {
  if (!u || typeof u !== 'object') return false;
  const candidate = u as {
    role?: string;
    roles?: unknown;
    permissions?: unknown;
  };

  const roles = Array.isArray(candidate.roles) ? (candidate.roles as string[]) : [];
  const perms = Array.isArray(candidate.permissions) ? (candidate.permissions as string[]) : [];

  return (
    candidate.role === 'admin' ||
    roles.includes('admin') ||
    perms.includes('admin:read') ||
    perms.includes('admin:write')
  );
}

const BanBodyZ = z.object({
  reason: z.string().min(3).max(500),
  days: z.coerce.number().int().positive().max(365).optional(),
  until: z
    .string()
    .datetime()
    .refine((value: string) => !Number.isNaN(Date.parse(value)), 'invalid until date')
    .optional(),
});

export const POST = withAuth({})(async (req, ctx) => {
  const userId = ctx.session?.user?.id;
  if (!userId) return jsonError(401, 'unauthorized');

  if (!isAdminish(ctx.session?.user)) return jsonError(403, 'forbidden');

  const ip = getClientIp(req);
  const userAgent = req.headers.get('user-agent') ?? undefined;

  try {
    await Promise.all([
      rateLimit(`rl:admin:ban:user:${userId}`, 20, 60),
      rateLimit(`rl:admin:ban:ip:${ip}`, 40, 60),
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  // Prefer ctx.params; fall back to Next req cast if present
  const routeId =
    (ctx as { params?: { id?: string } })?.params?.id ??
    (req as unknown as { params?: { id?: string } })?.params?.id;

  const parsedId = idParam.safeParse({ id: routeId });
  if (!parsedId.success) return jsonError(400, 'invalid_user_id');
  const targetId = parsedId.data.id;

  const parsed = BanBodyZ.safeParse(await req.json());
  if (!parsed.success) return jsonError(400, 'invalid_request_body');
  const body = parsed.data;

  // Enforce: either `days` or `until`
  if (!body.days && !body.until) {
    return jsonError(400, 'either_days_or_until_required');
  }

  let banExpiresAt: Date | null = null;
  if (body.until) banExpiresAt = new Date(body.until);
  else if (body.days) banExpiresAt = new Date(Date.now() + body.days * 24 * 60 * 60 * 1000);

  if (targetId === userId) {
    return jsonError(400, 'cannot_ban_self');
  }

  const now = new Date();
  try {
    const user = await prisma.user.update({
      where: { id: targetId },
      data: { bannedAt: now /*, banExpiresAt*/ },
      select: { id: true },
    });

    auditEvent('admin.user.ban', {
      actorId: userId,
      subjectId: targetId,
      reason: body.reason,
      banExpiresAt,
      ip,
      userAgent,
    }).catch(() => {});

    return new Response(
      JSON.stringify({
        ok: true,
        userId: user.id,
        banned: true,
        banExpiresAt: banExpiresAt?.toISOString() ?? null,
      }),
      { status: 200, headers: JSON_NOSTORE },
    );
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2025') {
      return jsonError(404, 'user_not_found');
    }
    return jsonError(500, 'internal_error');
  }
});

function getClientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for');
  if (xf) {
    const first = xf.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? '0.0.0.0';
}
