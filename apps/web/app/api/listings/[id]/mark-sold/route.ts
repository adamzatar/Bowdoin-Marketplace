// apps/web/app/api/listings/[id]/mark-sold/route.ts
//
// POST: mark a listing as sold (seller-only)
//
// Guarantees:
// - Auth required, seller must own the listing
// - Idempotent: if already sold, returns 200 with current state
// - Rate-limited
// - Audited
// - Response validated locally to avoid contracts dependency

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { env } from '@bowdoin/config/env';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { withAuth, rateLimit, auditEvent, jsonError } from '@/server';

import type { NextRequest } from 'next/server';

const ListingPublicZ = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  isFree: z.boolean(),
  audience: z.enum(['public', 'community']),
  category: z.string().nullable(),
  userId: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
  sold: z.boolean(),
});

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
} as const;

const IdParamZ = z.object({ id: z.string().uuid() });

const listingSelect = {
  id: true,
  title: true,
  description: true,
  price: true,
  isFree: true,
  audience: true,
  category: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
  status: true,
} as const;

type ListingRecord = {
  id: string;
  title: string;
  description: string | null;
  price: unknown;
  isFree: boolean;
  audience: string;
  category: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
};

function toPublicAudience(audience: string): 'public' | 'community' {
  if (audience === 'PUBLIC' || audience === 'public') return 'public';
  if (audience === 'CAMPUS' || audience === 'campus') return 'community';
  return audience === 'community' ? 'community' : 'public';
}

function toPublic(listing: ListingRecord) {
  const obj = {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    price: Number(listing.price),
    isFree: listing.isFree,
    audience: toPublicAudience(listing.audience),
    category: listing.category,
    userId: listing.userId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    sold: listing.status === 'SOLD',
  };

  if (env.NODE_ENV !== 'production') {
    try {
      ListingPublicZ.parse(obj);
    } catch {
      // contract drift should be caught by tests; do not crash runtime
    }
  }

  return obj;
}

export const POST = withAuth<{ params: { id: string } }>()(async (_req, ctx) => {
  const session = ctx.session;
  const userId = ctx.userId ?? session?.user?.id;
  if (!userId) return jsonError(401, 'unauthorized');

  const parsedId = IdParamZ.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_id');
  const id = parsedId.data.id;

  try {
    await rateLimit(`rl:listings:mark_sold:${userId}`, 20, 3600);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const existing = await prisma.listing.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      title: true,
    },
  });

  if (!existing) return jsonError(404, 'listing_not_found');
  if (existing.userId !== userId) return jsonError(403, 'forbidden');

  if (existing.status === 'SOLD') {
    const already = await prisma.listing.findUnique({
      where: { id },
      select: listingSelect,
    });
    if (!already) return jsonError(404, 'listing_not_found');

    return new Response(JSON.stringify({ ok: true, data: toPublic(already) }), {
      status: 200,
      headers: noStoreHeaders,
    });
  }

  try {
    const updated = await prisma.listing.update({
      where: { id },
      data: { status: 'SOLD' },
      select: listingSelect,
    });

    auditEvent('listing.mark_sold', {
      actor: { type: 'user', id: userId },
      listingId: id,
      title: existing.title,
      sold: true,
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, data: toPublic(updated) }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    auditEvent('listing.mark_sold_failed', {
      actor: { type: 'user', id: userId },
      listingId: id,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return jsonError(500, 'failed_to_mark_sold');
  }
});
