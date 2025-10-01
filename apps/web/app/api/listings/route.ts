// apps/web/app/api/listings/route.ts
//
// Listings collection endpoint
// - GET: list & paginate listings with basic filters
// - POST: create a new listing (authenticated)
// - Includes input validation (zod), rate limiting, auditing, and cache control

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { headers } from 'next/headers';

import { prisma } from '@bowdoin/db';
import { z } from 'zod';
import { withAuth, rateLimit, auditEvent, jsonError } from '@/server';

import type { Prisma } from '@prisma/client';

const QueryParamsZ = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(64).optional(),
  audience: z.enum(['public', 'community']).optional(),
  minPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  maxPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  includeSold: z.coerce.boolean().optional().default(false),
});

const CreateListingZ = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4_000).optional(),
  price: z.number().nonnegative(),
  audience: z.enum(['public', 'community']).optional(),
  category: z.string().trim().max(64).optional(),
});

const noStore = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
} as const;

const listingSelect = {
  id: true,
  userId: true,
  title: true,
  description: true,
  price: true,
  isFree: true,
  condition: true,
  audience: true,
  status: true,
  category: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ListingRecord = Prisma.ListingGetPayload<{ select: typeof listingSelect }>;

type PublicListing = {
  id: string;
  title: string;
  description: string;
  price: number;
  isFree: boolean;
  audience: 'public' | 'community';
  category: string | null;
  condition: string | null;
  status: 'active' | 'sold' | 'expired' | 'removed';
  sellerId: string;
  createdAt: Date;
  updatedAt: Date;
};

type DbAudience = 'PUBLIC' | 'CAMPUS';
type DbStatus = 'ACTIVE' | 'SOLD' | 'EXPIRED' | 'REMOVED';
type DbCondition = string;

function toAudienceEnum(input: 'public' | 'community'): DbAudience {
  return input === 'public' ? 'PUBLIC' : 'CAMPUS';
}

function toPublicAudience(input: DbAudience): 'public' | 'community' {
  return input === 'PUBLIC' ? 'public' : 'community';
}

function toPublicStatus(status: DbStatus): 'active' | 'sold' | 'expired' | 'removed' {
  switch (status) {
    case 'SOLD':
      return 'sold';
    case 'EXPIRED':
      return 'expired';
    case 'REMOVED':
      return 'removed';
    case 'ACTIVE':
    default:
      return 'active';
  }
}

function toPublicCondition(condition: DbCondition | null): string | null {
  return condition ? condition.toLowerCase() : null;
}

function formatListing(listing: ListingRecord): PublicListing {
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description ?? '',
    price: Number(listing.price),
    isFree: listing.isFree,
    audience: toPublicAudience(listing.audience),
    category: listing.category,
    condition: toPublicCondition(listing.condition),
    status: toPublicStatus(listing.status),
    sellerId: listing.userId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}

/** GET /api/listings */
export async function GET(req: Request) {
  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || '0.0.0.0';

  try {
    await rateLimit(`rl:listings:list:${ip}`, 120, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const url = new URL(req.url);
  const parsed = QueryParamsZ.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_query', details: parsed.error.flatten() }),
      { status: 400, headers: noStore },
    );
  }

  const { q, category, audience, minPrice, maxPrice, cursor, limit, includeSold } = parsed.data;

  const where: Prisma.ListingWhereInput = {};
  if (category) where.category = category;
  if (audience) where.audience = toAudienceEnum(audience);
  if (!includeSold) where.status = { not: 'SOLD' };

  if (minPrice != null || maxPrice != null) {
    const priceFilter: Prisma.DecimalFilter = {};
    if (minPrice != null) priceFilter.gte = minPrice;
    if (maxPrice != null) priceFilter.lte = maxPrice;
    where.price = priceFilter;
  }

  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const take = limit + 1;
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  let cursorClause: Prisma.ListingWhereUniqueInput | undefined;
  if (cursor) {
    cursorClause = { id: cursor };
  }

  const rows = await prisma.listing.findMany({
    where,
    orderBy,
    take,
    ...(cursorClause ? { cursor: cursorClause, skip: 1 } : {}),
    select: listingSelect,
  });

  let items = rows;
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const next = rows[rows.length - 1] ?? null;
    if (next) {
      nextCursor = next.id;
      items = rows.slice(0, limit);
    }
  }

  const data = items.map(formatListing);

  return new Response(JSON.stringify({ data, nextCursor }), {
    status: 200,
    headers: noStore,
  });
}

/** POST /api/listings */
export const POST = withAuth()(async (req, ctx) => {
  const userId = ctx.userId ?? ctx.session?.user?.id;
  if (!userId) return jsonError(401, 'unauthorized');

  try {
    await rateLimit(`rl:listings:create:${userId}`, 10, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const parsed = CreateListingZ.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_body', details: parsed.error.flatten() }),
      { status: 400, headers: noStore },
    );
  }

  const input = parsed.data;
  const priceNum = input.price;
  const isFree = priceNum === 0;
  const audienceEnum = toAudienceEnum(input.audience ?? 'community');

  try {
    const created = await prisma.listing.create({
      data: {
        userId,
        title: input.title,
        description: input.description ?? null,
        price: priceNum,
        isFree,
        audience: audienceEnum,
        category: input.category ?? null,
      },
      select: listingSelect,
    });

    const listing = formatListing(created);

    const priceCents = Math.round(listing.price * 100);
    auditEvent('listing.created', {
      actor: { type: 'user', id: userId },
      listingId: listing.id,
      priceCents,
      currency: 'USD',
      audience: listing.audience,
      category: listing.category ?? undefined,
      tags: [],
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, listing }), {
      status: 201,
      headers: noStore,
    });
  } catch (err) {
    auditEvent('listing.create_failed', {
      actor: { type: 'user', id: userId },
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return jsonError(500, 'failed to create listing');
  }
});
