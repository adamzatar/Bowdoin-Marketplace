// apps/web/app/api/admin/users/[id]/ban/route.ts
//
// Admin: ban a user (optionally until a specific time).
// - Auth required + admin permission
// - Body validation (reason, duration / until)
// - Defensive rate limits (per-admin + per-IP)
// - Audited mutation
//
// NOTE: This assumes your `User` model has some combination of fields like:
//   banned        Boolean
//   bannedAt      DateTime?
//   bannedById    String? (UUID)
//   banReason     String?
//   banExpiresAt  DateTime?
// If your schema differs, adjust the `data` block accordingly.

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { auditEvent } from '../../../../../../src/server/handlers/audit';
import { jsonError } from '../../../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../../../src/server/rateLimit';
import { idParam } from '../../../../../../src/server/validators';
import { withAuth } from '../../../../../../src/server/withAuth';

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// Treat any of these shapes as “admin”
function isAdminish(u: any): boolean {
  return (
    u?.role === 'admin' ||
    (Array.isArray(u?.roles) && u.roles.includes('admin')) ||
    (Array.isArray(u?.permissions) &&
      (u.permissions.includes('admin:read') || u.permissions.includes('admin:write')))
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

export const POST = withAuth(async (req, ctx) => {
  if (!isAdminish(ctx.session.user)) return jsonError(403, 'forbidden');

  // Per-admin + per-IP rate limits for this sensitive action
  try {
    await Promise.all([
      rateLimit(`rl:admin:ban:user:${ctx.session.user.id}`, 20, 60), // 20/min per admin
      rateLimit(`rl:admin:ban:ip:${ctx.ip}`, 40, 60), // 40/min per IP
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
  } catch (err) {
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
  if (targetId === ctx.session.user.id) {
    return jsonError(400, 'cannot_ban_self');
  }

  // Update user record
  // If your schema differs, adjust fields below.
  const now = new Date();
  try {
    const user = await prisma.user.update({
      where: { id: targetId },
      data: {
        banned: true as any,
        bannedAt: now as any,
        bannedById: ctx.session.user.id as any,
        banReason: body.reason as any,
        banExpiresAt: banExpiresAt as any,
      },
      select: { id: true },
    });

    // Fire-and-forget audit
    auditEvent('admin.user.ban', {
      actorId: ctx.session.user.id,
      subjectId: targetId,
      reason: body.reason,
      banExpiresAt,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    }).catch(() => {});

    // (Optional) session invalidation could be implemented if you manage sessions server-side.
    // For example, deleting active sessions for the banned user to force sign-out.

    return new Response(
      JSON.stringify({
        ok: true,
        userId: user.id,
        banned: true,
        banExpiresAt: banExpiresAt?.toISOString() ?? null,
      }),
      { status: 200, headers: JSON_NOSTORE },
    );
  } catch (e: any) {
    // Not found or constraint errors
    if (e?.code === 'P2025') {
      return jsonError(404, 'user_not_found');
    }
    return jsonError(500, 'internal_error');
  }
});

export const dynamic = 'force-dynamic';
export const revalidate = 0;
