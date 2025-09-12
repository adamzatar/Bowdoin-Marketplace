// apps/web/app/api/listings/route.ts
//
// Listings collection endpoint
// - GET: list & paginate listings with basic filters
// - POST: create a new listing (authenticated)
// - Includes input validation (zod), rate limiting, auditing, and cache control
//
// Dependencies expected in the monorepo:
//   - @bowdoin/db -> exports `prisma`
//   - @bowdoin/contracts/schemas/listings -> zod schemas used below
//   - Local server utils: rateLimit, errorHandler, withAuth, audit

import { ListingCreateInputZ, ListingPublicZ } from '@bowdoin/contracts/schemas/listings';
import { prisma } from '@bowdoin/db';
import { headers } from 'next/headers';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { emitAuditEvent } from '../../../src/server/handlers/audit';
import { jsonError } from '../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../src/server/rateLimit';
import { requireSession } from '../../../src/server/withAuth';

// Prefer using the canonical contracts schemas if present.

// If your contracts don’t yet include query params, we define them here.
// Cursor is an encoded string of the last item’s ID (or createdAt+id).
const QueryParamsZ = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(64).optional(),
  audience: z.enum(['public', 'community']).optional(),
  minPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  maxPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  // simple cursor; you can switch to opaque Base64 with createdAt|id if you prefer
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  // include sold?
  includeSold: z.coerce.boolean().optional().default(false),
});

// Safety: don’t cache dynamic API responses
const noStore = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/listings */
export async function GET(req: NextRequest) {
  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || '0.0.0.0';

  // Rate limit by IP for anonymous browsing (burst 120/min)
  try {
    await rateLimit(`rl:listings:list:${ip}`, 120, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Parse query params
  const url = new URL(req.url);
  const parsed = QueryParamsZ.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_query', details: parsed.error.flatten() }),
      { status: 400, headers: noStore },
    );
  }
  const { q, category, audience, minPrice, maxPrice, cursor, limit, includeSold } = parsed.data;

  // Build filters
  const where: any = {};
  if (category) where.category = category;
  if (audience) where.audience = audience;
  if (!includeSold) where.soldAt = null;

  if (minPrice != null || maxPrice != null) {
    where.priceCents = {};
    if (minPrice != null) where.priceCents.gte = Math.round(minPrice * 100);
    if (maxPrice != null) where.priceCents.lte = Math.round(maxPrice * 100);
  }

  // Basic text filter (fallback). If you added FTS, replace with your search view.
  // We still include a minimal `contains` condition for q.
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { tags: { hasSome: q.split(/\s+/).filter(Boolean) } },
    ];
  }

  // Cursor-based pagination: use id cursor (stable ordering by createdAt desc, id desc)
  const take = limit + 1; // fetch one extra to compute nextCursor
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  let cursorClause: any = undefined;
  if (cursor) {
    cursorClause = { id: cursor };
  }

  const rows = await prisma.listing.findMany({
    where,
    orderBy,
    take,
    ...(cursorClause ? { skip: 1, cursor: cursorClause } : {}),
    select: {
      id: true,
      title: true,
      description: true,
      priceCents: true,
      currency: true,
      audience: true,
      category: true,
      images: true,
      tags: true,
      sellerId: true,
      createdAt: true,
      updatedAt: true,
      soldAt: true,
    },
  });

  // Compute next cursor
  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    const next = rows[rows.length - 1];
    nextCursor = next.id;
    items = rows.slice(0, limit);
  }

  // Map DB -> public contract (price in dollars etc.) if needed
  const data = items.map((r) => {
    const obj = {
      id: r.id,
      title: r.title,
      description: r.description,
      price: r.priceCents / 100,
      currency: r.currency,
      audience: r.audience,
      category: r.category,
      images: r.images,
      tags: r.tags,
      sellerId: r.sellerId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      soldAt: r.soldAt,
    };
    // Validate at the boundary in dev/test to catch drift (no-op cost in prod if you prefer)
    try {
      ListingPublicZ.parse(obj);
    } catch {
      // Don’t fail the request in prod; you can log if desired.
    }
    return obj;
  });

  return new Response(JSON.stringify({ data, nextCursor }), {
    status: 200,
    headers: noStore,
  });
}

/** POST /api/listings */
export async function POST(req: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const session = auth.session;

  // Rate limit per-user for creation (10/min acceptable burst)
  try {
    await rateLimit(`rl:listings:create:${session.user.id}`, 10, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const body = await req.json().catch(() => null as unknown as z.infer<typeof ListingCreateInputZ>);
  const parsed = ListingCreateInputZ.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_body', details: parsed.error.flatten() }),
      { status: 400, headers: noStore },
    );
  }

  const input = parsed.data;

  // Normalize data
  const priceCents = Math.round(input.price * 100);

  try {
    const created = await prisma.listing.create({
      data: {
        title: input.title,
        description: input.description ?? '',
        priceCents,
        currency: input.currency ?? 'USD',
        audience: input.audience ?? 'community',
        category: input.category ?? null,
        images: input.images ?? [],
        tags: input.tags ?? [],
        sellerId: session.user.id,
      },
      select: {
        id: true,
        title: true,
        description: true,
        priceCents: true,
        currency: true,
        audience: true,
        category: true,
        images: true,
        tags: true,
        sellerId: true,
        createdAt: true,
        updatedAt: true,
        soldAt: true,
      },
    });

    const response = {
      id: created.id,
      title: created.title,
      description: created.description,
      price: created.priceCents / 100,
      currency: created.currency,
      audience: created.audience,
      category: created.category,
      images: created.images,
      tags: created.tags,
      sellerId: created.sellerId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      soldAt: created.soldAt,
    };

    // Audit fire-and-forget
    emitAuditEvent('listing.created', {
      actor: { type: 'user', id: session.user.id },
      listingId: created.id,
      priceCents: created.priceCents,
      currency: created.currency,
      audience: created.audience,
      category: created.category ?? undefined,
      tags: created.tags,
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, listing: response }), {
      status: 201,
      headers: noStore,
    });
  } catch (err) {
    emitAuditEvent('listing.create_failed', {
      actor: { type: 'user', id: session.user.id },
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return jsonError(500, 'failed to create listing');
  }
}
