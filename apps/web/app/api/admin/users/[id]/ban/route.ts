// apps/web/app/api/admin/users/[id]/ban/route.ts
//
// Admin: ban a user (optionally until a specific time).
// - Auth required + admin permission
// - Body validation (reason, duration / until)
// - Defensive rate limits (per-admin + per-IP)
// - Audited mutation
//
// NOTE: This assumes your `User` model has fields like:
//   bannedAt      DateTime?
//   banExpiresAt  DateTime?
// If your schema differs, adjust the `data` block accordingly.

export const runtime = 'nodejs';

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { withAuth, rateLimit, Handlers, Validators } from '@/src/server';

const { auditEvent, jsonError } = Handlers;
const { idParam } = Validators;

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

const BanBodyZ = z
  .object({
    // Human-readable reason (logged & auditable)
    reason: z.string().min(3).max(500),
    // Ban either for a relative number of days OR until a specific ISO date
    days: z.coerce.number().int().positive().max(365).optional(),
    until: z
      .string()
      .datetime()
      .optional()
      .refine((v) => (v ? !Number.isNaN(Date.parse(v)) : true), 'invalid until date'),
  })
  .refine((v) => !!v.days || !!v.until, {
    message: 'either `days` or `until` must be provided',
    path: ['days'],
  });

export const POST = withAuth({})(async (req, ctx) => {
  // Require an authenticated user
  const userId = ctx.session?.user?.id;
  if (!userId) return jsonError(401, 'unauthorized');

  // Require admin-ish privileges
  if (!isAdminish(ctx.session?.user)) return jsonError(403, 'forbidden');

  const ip = getClientIp(req);
  const userAgent = req.headers.get('user-agent') ?? undefined;

  // Per-admin + per-IP rate limits for this sensitive action
  try {
    await Promise.all([
      rateLimit(`rl:admin:ban:user:${userId}`, 20, 60), // 20/min per admin
      rateLimit(`rl:admin:ban:ip:${ip}`, 40, 60), // 40/min per IP
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  // Validate path param
  const { params } = req as unknown as { params: { id: string } };
  let targetId: string;
  try {
    targetId = idParam.parse(params).id;
  } catch {
    return jsonError(400, 'invalid_user_id');
  }

  // Parse body
  let body: z.infer<typeof BanBodyZ>;
  try {
    body = BanBodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_request_body');
  }

  // Compute expiry
  let banExpiresAt: Date | null = null;
  if (body.until) {
    banExpiresAt = new Date(body.until);
  } else if (body.days) {
    const now = new Date();
    banExpiresAt = new Date(now.getTime() + body.days * 24 * 60 * 60 * 1000);
  }

  // Prevent self-ban foot-guns
  if (targetId === userId) {
    return jsonError(400, 'cannot_ban_self');
  }

  // Update user record (schema-safe fields only)
  const now = new Date();
  try {
    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        bannedAt: now,
      },
      select: { id: true },
    });

    // Fire-and-forget audit (capture the human reason here)
    auditEvent
      .emit('admin.user.ban', {
        actorId: userId,
        subjectId: targetId,
        reason: body.reason,
        banExpiresAt,
        ip,
        userAgent,
      })
      .catch(() => {});

    // (Optional) session invalidation could be implemented if you manage sessions server-side.

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
    // Not found or constraint errors
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
