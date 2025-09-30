// apps/web/app/api/admin/reports/route.ts
//
// Admin: list and bulk-resolve abuse reports.
// - Auth required + admin permission
// - Cursor pagination + filtering by status/type
// - Defensive rate limits (per-user + per-IP)
// - Audited mutations
//
// NOTE: This assumes a Prisma model `Report` with (id, status, reason,
// createdAt, reportedListingId?, reportedUserId?, reporterId?) fields. If your field
// names differ, tweak the `select`/`where`/`data` blocks accordingly.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { withAuth, rateLimit, auditEvent, jsonError } from '@/server';

import type { Prisma } from '@prisma/client';

// ---------- helpers

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

function isAdminish(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false;

  const candidate = user as {
    role?: unknown;
    roles?: unknown;
    permissions?: unknown;
  };

  const role = typeof candidate.role === 'string' ? candidate.role : null;
  const roles = Array.isArray(candidate.roles) ? candidate.roles : [];
  const permissions = Array.isArray(candidate.permissions) ? candidate.permissions : [];

  return (
    role === 'admin' ||
    roles.some((r) => String(r).toLowerCase() === 'admin') ||
    permissions.some((p) => {
      const value = String(p).toLowerCase();
      return value === 'admin:read' || value === 'admin:write';
    })
  );
}

const withStrictAuth = withAuth<{ params?: Record<string, string>; ip: string }>();

// ---------- validation

const StatusZ = z.enum(['OPEN', 'REVIEWED', 'ACTIONED', 'DISMISSED']).default('OPEN');
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

export const GET = withStrictAuth(async (req, ctx) => {
  const user = ctx.session?.user;
  const userId = typeof user?.id === 'string' ? user.id : null;
  if (!userId || !isAdminish(user)) return jsonError(403, 'forbidden');

  try {
    await Promise.all([
      rateLimit(`rl:admin:reports:list:user:${userId}`, 120, 60),
      rateLimit(`rl:admin:reports:list:ip:${ctx.ip}`, 200, 60),
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
    ...(type === 'LISTING' ? { reportedListingId: { not: null } } : {}),
    ...(type === 'USER' ? { reportedUserId: { not: null } } : {}),
  };

  const results = await prisma.report.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      reason: true,
      createdAt: true,
      reportedListingId: true,
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

  const transformed = items.map(({ reportedListingId, ...rest }) => ({
    ...rest,
    listingId: reportedListingId,
  }));

  return new Response(JSON.stringify({ ok: true, items: transformed, nextCursor }), {
    status: 200,
    headers: JSON_NOSTORE,
  });
});

// ---------- POST /api/admin/reports
// Bulk resolve a set of reports (idempotent)

export const POST = withStrictAuth(async (req, ctx) => {
  const user = ctx.session?.user;
  const userId = typeof user?.id === 'string' ? user.id : null;
  if (!userId || !isAdminish(user)) return jsonError(403, 'forbidden');

  try {
    await Promise.all([
      rateLimit(`rl:admin:reports:resolve:user:${userId}`, 30, 60),
      rateLimit(`rl:admin:reports:resolve:ip:${ctx.ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  const parsedBody = BulkResolveBodyZ.safeParse(await req.json());
  if (!parsedBody.success) {
    return jsonError(400, 'invalid_request_body');
  }
  const body = parsedBody.data;

  const updated = await prisma.report.updateMany({
    where: { id: { in: body.ids }, status: 'OPEN' },
    data: {
      status: 'ACTIONED',
    },
  });

  await auditEvent('admin.report.bulk_resolve', {
    actor: { id: userId },
    target: { type: 'report.bulk', id: body.ids.join(',') },
    meta: { count: updated.count, note: body.note, ip: ctx.ip, route: '/api/admin/reports' },
    outcome: 'success',
  });

  return new Response(JSON.stringify({ ok: true, updated: updated.count }), {
    status: 200,
    headers: JSON_NOSTORE,
  });
});
