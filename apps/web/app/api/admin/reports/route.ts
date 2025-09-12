// apps/web/app/api/admin/reports/route.ts
//
// Admin: list and bulk-resolve abuse reports.
// - Auth required + admin permission
// - Cursor pagination + filtering by status/type
// - Defensive rate limits (per-user + per-IP)
// - Audited mutations
//
// NOTE: This assumes a Prisma model `Report` with (id, type, status, reason,
// createdAt, listingId?, reportedUserId?, reporterId?) fields. If your field
// names differ, tweak the `select`/`where`/`data` blocks accordingly.

import { env } from '@bowdoin/config/env';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { Prisma } from '@bowdoin/db';

import { auditEvent } from '../../../../src/server/handlers/audit';
import { jsonError } from '../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../src/server/rateLimit';
import { withAuth } from '../../../../src/server/withAuth';

// ---------- helpers

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

function isAdminish(u: any): boolean {
  // Flexible checks to work with a few session shapes
  return (
    u?.role === 'admin' ||
    (Array.isArray(u?.roles) && u.roles.includes('admin')) ||
    (Array.isArray(u?.permissions) &&
      (u.permissions.includes('admin:read') || u.permissions.includes('admin:write')))
  );
}

// ---------- validation

const StatusZ = z.enum(['OPEN', 'RESOLVED']).default('OPEN');
const TypeZ = z.enum(['LISTING', 'USER']).optional();

const ListQueryZ = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().nullish(),
  status: StatusZ,
  type: TypeZ,
});

const BulkResolveBodyZ = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  note: z.string().max(500).optional(),
});

// ---------- GET /api/admin/reports
// List reports with cursor pagination

export const GET = withAuth(async (req, ctx) => {
  if (!isAdminish(ctx.session.user)) return jsonError(403, 'forbidden');

  // rate limit (per-admin + per-ip)
  try {
    await Promise.all([
      rateLimit(`rl:admin:reports:list:user:${ctx.session.user.id}`, 120, 60), // 120/min/user
      rateLimit(`rl:admin:reports:list:ip:${ctx.ip}`, 200, 60), // 200/min/ip
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  const url = new URL(req.url);
  const parsed = ListQueryZ.safeParse({
    limit: url.searchParams.get('limit'),
    cursor: url.searchParams.get('cursor'),
    status: url.searchParams.get('status') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
  });
  if (!parsed.success) return jsonError(400, 'invalid_query');

  const { limit, cursor, status, type } = parsed.data;

  const where: Prisma.ReportWhereInput = {
    status,
    ...(type ? { type } : {}),
  };

  const results = await prisma.report.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      type: true,
      status: true,
      reason: true,
      createdAt: true,
      listingId: true,
      reportedUserId: true,
      reporterId: true,
    },
  });

  let nextCursor: string | null = null;
  let items = results;
  if (results.length > limit) {
    const next = results.pop();
    nextCursor = next ? next.id : null;
    items = results;
  }

  return new Response(JSON.stringify({ ok: true, items, nextCursor }), {
    status: 200,
    headers: JSON_NOSTORE,
  });
});

// ---------- POST /api/admin/reports
// Bulk resolve a set of reports (idempotent)

export const POST = withAuth(async (req, ctx) => {
  if (!isAdminish(ctx.session.user)) return jsonError(403, 'forbidden');

  // rate limit (tighter for mutations)
  try {
    await Promise.all([
      rateLimit(`rl:admin:reports:resolve:user:${ctx.session.user.id}`, 30, 60), // 30/min/user
      rateLimit(`rl:admin:reports:resolve:ip:${ctx.ip}`, 60, 60), // 60/min/ip
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  let body: z.infer<typeof BulkResolveBodyZ>;
  try {
    body = BulkResolveBodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_request_body');
  }

  // Update reports (only OPEN -> RESOLVED)
  const updated = await prisma.report.updateMany({
    where: { id: { in: body.ids }, status: 'OPEN' },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedById: ctx.session.user.id,
      resolutionNote: body.note ?? null,
    } as any, // if your schema uses different names, adjust here
  });

  // Fire-and-forget audit
  auditEvent('admin.report.bulk_resolve', {
    actorId: ctx.session.user.id,
    count: updated.count,
    ids: body.ids,
    note: body.note,
    ip: ctx.ip,
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, updated: updated.count }), {
    status: 200,
    headers: JSON_NOSTORE,
  });
});

// --------- Optional: disable caching aggressively (already via headers above)
export const dynamic = 'force-dynamic';
export const revalidate = 0;
