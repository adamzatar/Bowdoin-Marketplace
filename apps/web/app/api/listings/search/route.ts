// apps/web/app/api/listings/search/route.ts
//
// GET: search listings with pagination & filters
//
// Notes
// - Public endpoint: unauthenticated users only see `audience = "public"`
// - Authenticated & affiliation-verified users also see `audience = "community"`
// - Safe, bounded pagination and simple text search
// - Sort by recency (default) or price asc/desc
// - Rate-limited per-IP (and per-user when available)
// - Stable contract: items conform to ListingPublicZ
//
// Example:
//   /api/listings/search?q=bike&category=transport&page=1&pageSize=20&sort=price_asc

import { ListingPublicZ } from '@bowdoin/contracts/schemas/listings';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { getContext } from '../../../../src/server/context';
import { jsonError } from '../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../src/server/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SortEnum = z.enum(['recent', 'price_asc', 'price_desc']);
const AudienceEnum = z.enum(['public', 'community']).optional(); // server-enforced too

const QueryZ = z.object({
  q: z.string().trim().min(1).max(128).optional(),
  category: z.string().trim().max(64).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  audience: AudienceEnum, // ignored if unauthenticated / unverified
  tag: z.union([z.string().trim().max(32), z.array(z.string().trim().max(32))]).optional(),
  sellerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: SortEnum.default('recent'),
  includeSold: z
    .union([z.literal('0'), z.literal('1')])
    .transform((v) => v === '1')
    .optional(),
});

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

type ListingShape = {
  id: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  audience: 'public' | 'community';
  category: string | null;
  images: string[];
  tags: string[];
  sellerId: string;
  createdAt: Date;
  updatedAt: Date;
  soldAt: Date | null;
};

function toPublic(l: ListingShape) {
  const obj = {
    id: l.id,
    title: l.title,
    description: l.description ?? '',
    price: l.priceCents / 100,
    currency: l.currency,
    audience: l.audience,
    category: l.category,
    images: l.images,
    tags: l.tags,
    sellerId: l.sellerId,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    soldAt: l.soldAt,
  };
  if (process.env.NODE_ENV !== 'production') {
    try {
      ListingPublicZ.parse(obj);
    } catch {
      // contract drift should be caught by tests
    }
  }
  return obj;
}

export async function GET(req: NextRequest) {
  // Parse & validate query
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());
  // Collect multi-tag ?tag=…&tag=… cases
  const tagsMulti = url.searchParams.getAll('tag');
  if (tagsMulti.length > 1) {
    (params as any).tag = tagsMulti;
  }

  const parsed = QueryZ.safeParse(params);
  if (!parsed.success) return jsonError(400, 'invalid_query');
  const q = parsed.data;

  // Context (auth optional)
  const { ip, session } = await getContext(req);

  // Rate limit (per ip + per user when present)
  try {
    await Promise.all([
      rateLimit(`rl:listings:search:ip:${ip}`, 60, 60), // 60 req/min per IP
      session
        ? rateLimit(`rl:listings:search:user:${session.user.id}`, 120, 60)
        : Promise.resolve(),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Audience gate
  const canSeeCommunity = !!session && (session.user as any)?.affiliationVerified === true;
  const requestedAudience = q.audience;
  const audienceFilter: ('public' | 'community')[] = (() => {
    if (requestedAudience) {
      // If caller explicitly requests community but cannot see it, restrict to public.
      if (requestedAudience === 'community' && !canSeeCommunity) return ['public'];
      return requestedAudience === 'public' ? ['public'] : ['public', 'community'];
    }
    return canSeeCommunity ? ['public', 'community'] : ['public'];
  })();

  // Filters
  const where: any = {
    audience: { in: audienceFilter },
  };

  if (q.category) where.category = q.category;
  if (q.sellerId) where.sellerId = q.sellerId;

  if (q.minPrice != null || q.maxPrice != null) {
    where.priceCents = {};
    if (q.minPrice != null) where.priceCents.gte = Math.round(q.minPrice * 100);
    if (q.maxPrice != null) where.priceCents.lte = Math.round(q.maxPrice * 100);
  }

  if (q.tag) {
    const tags = Array.isArray(q.tag) ? q.tag : [q.tag];
    // Require all provided tags to be present
    where.tags = { hasEvery: tags };
  }

  if (!q.includeSold) {
    where.soldAt = null;
  }

  // Simple text search across title/description/tags (case-insensitive).
  // We keep it Prisma-native for portability; DB-specific FTS is great but optional.
  if (q.q) {
    const term = q.q;
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { tags: { has: term.toLowerCase() } },
    ];
  }

  // Sorting
  const orderBy =
    q.sort === 'recent'
      ? [{ updatedAt: 'desc' as const }, { createdAt: 'desc' as const }]
      : q.sort === 'price_asc'
        ? [{ priceCents: 'asc' as const }, { updatedAt: 'desc' as const }]
        : [{ priceCents: 'desc' as const }, { updatedAt: 'desc' as const }];

  // Pagination (1-based page)
  const page = q.page;
  const pageSize = q.pageSize;
  const skip = (page - 1) * pageSize;
  const take = pageSize;

  try {
    const [total, rows] = await Promise.all([
      prisma.listing.count({ where }),
      prisma.listing.findMany({
        where,
        orderBy,
        skip,
        take,
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
      }),
    ]);

    const items = rows.map(toPublic);
    const hasMore = skip + rows.length < total;

    const payload = {
      ok: true,
      data: {
        items,
        page,
        pageSize,
        total,
        hasMore,
      },
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    return jsonError(500, 'search_failed');
  }
}
