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
// - Stable contract: public DTO derived locally (no dev-only schema assert)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

// Local/internal utilities (relative paths to avoid alias resolution issues)
import { rateLimit, jsonError } from '@/server';
import { getContext } from '@/server/context';

// type-only import placed after value imports to satisfy import/order
import type { NextRequest } from 'next/server';

const SortEnum = z.enum(['recent', 'price_asc', 'price_desc']);
const AudienceEnum = z.enum(['public', 'community']).optional(); // server-enforced too

const QueryZ = z.object({
  q: z.string().trim().min(1).max(128).optional(),
  category: z.string().trim().max(64).optional(),
  minPrice: z.coerce.number().nonnegative().optional(), // dollars
  maxPrice: z.coerce.number().nonnegative().optional(), // dollars
  audience: AudienceEnum, // ignored if unauthenticated / unverified
  // NOTE: tags/images not currently in DB; accept but ignore to keep contract flexible
  tag: z.union([z.string().trim().max(32), z.array(z.string().trim().max(32))]).optional(),
  sellerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: SortEnum.default('recent'),
  includeSold: z
    .union([z.literal('0'), z.literal('1')])
    .transform((value: '0' | '1') => value === '1')
    .optional(),
});

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
} as const;

// ---- DB shape (only fields that actually exist in the Prisma model) ----
type DbAudience = 'PUBLIC' | 'CAMPUS';
type ListingDbRow = {
  id: string;
  title: string;
  description: string | null;
  price: unknown; // Prisma.Decimal | number | string
  isFree: boolean;
  condition: string | null;
  category: string | null;
  location: string | null;
  audience: DbAudience;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
};

// ---- Public DTO (stable) ----
type PublicAudience = 'public' | 'community';
type ListingPublic = {
  id: string;
  title: string;
  description: string;
  price: number; // dollars
  currency: 'USD';
  audience: PublicAudience;
  category: string | null;
  images: string[];
  tags: string[];
  sellerId: string;
  createdAt: Date;
  updatedAt: Date;
  soldAt: Date | null; // not in DB yet; keep placeholder
};

// Helpers
function numFromDecimalLike(v: unknown): number {
  if (v && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v ?? 0);
}

function dbToPublicAudience(a: DbAudience): PublicAudience {
  return a === 'PUBLIC' ? 'public' : 'community';
}

// ---- Safe session helpers (avoid direct property access on unknown) ----
type SessionUserLike = { id?: string; affiliationVerified?: boolean } | undefined;
function extractUser(session: unknown): SessionUserLike {
  if (!session || typeof session !== 'object') return undefined;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return undefined;
  const result: Record<string, string | undefined | boolean> = {};
  const candidate = user as { id?: unknown; affiliationVerified?: unknown };
  if (typeof candidate.id === 'string') {
    result.id = candidate.id;
  }
  if (candidate.affiliationVerified === true) {
    result.affiliationVerified = true;
  }
  return result as SessionUserLike;
}

function toPublic(row: ListingDbRow): ListingPublic {
  const price = numFromDecimalLike(row.price);
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    price,
    currency: 'USD',
    audience: dbToPublicAudience(row.audience),
    category: row.category,
    images: [], // not stored yet
    tags: [], // not stored yet
    sellerId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    soldAt: null, // placeholder until schema supports it
  };
}

export async function GET(req: NextRequest) {
  // Parse & validate query (handle multi-tag ?tag=…&tag=…)
  const url = new URL(req.url);
  const baseParams = Object.fromEntries(url.searchParams.entries());
  const tagsMulti = url.searchParams.getAll('tag');
  const params: Record<string, unknown> =
    tagsMulti.length > 1 ? { ...baseParams, tag: tagsMulti } : baseParams;

  const parsed = QueryZ.safeParse(params);
  if (!parsed.success) return jsonError(400, 'invalid_query');
  const q = parsed.data;

  // Context (auth optional)
  const { ip, session } = await getContext(req);
  const user = extractUser(session);
  const userId = user?.id ?? null;

  // Rate limit (per ip + per user when present)
  try {
    await Promise.all([
      rateLimit(`rl:listings:search:ip:${ip}`, 60, 60), // 60 req/min per IP
      userId ? rateLimit(`rl:listings:search:user:${userId}`, 120, 60) : Promise.resolve(),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Audience gate
  const canSeeCommunity = user?.affiliationVerified === true;

  const requestedAudience = q.audience;
  const audienceFilter: PublicAudience[] = (() => {
    if (requestedAudience) {
      if (requestedAudience === 'community' && !canSeeCommunity) return ['public'];
      return requestedAudience === 'public' ? ['public'] : ['public', 'community'];
    }
    return canSeeCommunity ? ['public', 'community'] : ['public'];
  })();

  // Map public audience -> DB enum values
  const dbAudienceIn: DbAudience[] = audienceFilter.map((a) => (a === 'public' ? 'PUBLIC' : 'CAMPUS'));

  // Filters (only existing DB columns)
  const where: Record<string, unknown> = {
    audience: { in: dbAudienceIn },
  };
  if (q.category) where.category = q.category;
  if (q.sellerId) where.userId = q.sellerId;

  if (q.minPrice != null || q.maxPrice != null) {
    const price: Record<string, number> = {};
    if (q.minPrice != null) price.gte = q.minPrice;
    if (q.maxPrice != null) price.lte = q.maxPrice;
    where.price = price;
  }

  // Simple text search across title/description (case-insensitive)
  if (q.q) {
    const term = q.q;
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
    ];
  }

  // NOTE: tags/includeSold not supported by current schema; ignored safely.

  // Sorting
  const orderBy =
    q.sort === 'recent'
      ? [{ updatedAt: 'desc' as const }, { createdAt: 'desc' as const }]
      : q.sort === 'price_asc'
        ? [{ price: 'asc' as const }, { updatedAt: 'desc' as const }]
        : [{ price: 'desc' as const }, { updatedAt: 'desc' as const }];

  // Pagination (1-based page)
  const page = q.page;
  const pageSize = q.pageSize;
  const skip = (page - 1) * pageSize;
  const take = pageSize;

  try {
    const [total, rows] = await Promise.all([
      prisma.listing.count({ where: where as never }),
      prisma.listing.findMany({
        where: where as never,
        orderBy,
        skip,
        take,
        select: {
          id: true,
          title: true,
          description: true,
          price: true,
          isFree: true,
          condition: true,
          category: true,
          location: true,
          audience: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
          status: true,
        },
      }),
    ]);

    const items = rows.map(toPublic);
    const hasMore = skip + rows.length < total;

    return new Response(
      JSON.stringify(
        {
          ok: true,
          data: { items, page, pageSize, total, hasMore },
        },
        null,
        0,
      ),
      { status: 200, headers: noStoreHeaders },
    );
  } catch {
    return jsonError(500, 'search_failed');
  }
}
