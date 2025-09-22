// apps/web/app/api/listings/[id]/mark-sold/route.ts
//
// POST: mark a listing as sold (seller-only)
//
// Guarantees:
// - Auth required, seller must own the listing
// - Idempotent: if already sold, returns 200 with existing soldAt
// - Rate-limited
// - Audited
// - Contract-safe response shape

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { ListingPublicZ } from '@bowdoin/contracts/schemas/listings';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { emitAuditEvent } from '../../../../../src/server/handlers/audit';
import { jsonError } from '../../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../../src/server/rateLimit';
import { requireSession } from '../../../../../src/server/withAuth';

const IdParamZ = z.object({ id: z.string().uuid() });

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

function toPublic(listing: {
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
}) {
  const obj = {
    id: listing.id,
    title: listing.title,
    description: listing.description ?? '',
    price: listing.priceCents / 100,
    currency: listing.currency,
    audience: listing.audience,
    category: listing.category,
    images: listing.images,
    tags: listing.tags,
    sellerId: listing.sellerId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    soldAt: listing.soldAt,
  };
  if (process.env.NODE_ENV !== 'production') {
    try {
      ListingPublicZ.parse(obj);
    } catch {
      // contract drift should be caught by tests; don't crash prod
    }
  }
  return obj;
}

// Optional body: allow client to pass a timestamp (validated & clamped to now)
// for cases where a seller marks an older sale. We cap it to not be in future.
const BodyZ = z
  .object({
    soldAt: z.string().datetime().optional(),
  })
  .optional();

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  // AuthN
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const { session } = auth;

  // Params
  const parsedId = IdParamZ.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_id');
  const id = parsedId.data.id;

  // Rate limit: mark-sold is rare -> 20/hour per user
  try {
    await rateLimit(`rl:listings:mark_sold:${session.user.id}`, 20, 3600);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Parse body (optional)
  const raw = await req.text();
  let body: z.infer<typeof BodyZ> = undefined;
  if (raw && raw.trim() !== '') {
    try {
      body = BodyZ.parse(JSON.parse(raw));
    } catch {
      return jsonError(400, 'invalid_body');
    }
  }

  // Load and authorize
  const existing = await prisma.listing.findUnique({
    where: { id },
    select: {
      id: true,
      sellerId: true,
      soldAt: true,
      title: true,
    },
  });
  if (!existing) return jsonError(404, 'listing_not_found');
  if (existing.sellerId !== session.user.id) return jsonError(403, 'forbidden');

  // Idempotency: if already sold, just return success with the listing
  if (existing.soldAt) {
    const already = await prisma.listing.findUnique({
      where: { id },
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
    if (!already) return jsonError(404, 'listing_not_found'); // race (deleted)
    return new Response(JSON.stringify({ ok: true, data: toPublic(already) }), {
      status: 200,
      headers: noStoreHeaders,
    });
  }

  // Compute soldAt
  const now = new Date();
  let soldAt = now;
  if (body?.soldAt) {
    const requested = new Date(body.soldAt);
    // Clamp to not be in the future and not older than 1 year for sanity
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(now.getFullYear() - 1);
    if (requested.getTime() > now.getTime()) soldAt = now;
    else if (requested.getTime() < oneYearAgo.getTime()) soldAt = oneYearAgo;
    else soldAt = requested;
  }

  try {
    const updated = await prisma.listing.update({
      where: { id },
      data: { soldAt },
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

    emitAuditEvent('listing.mark_sold', {
      actor: { type: 'user', id: session.user.id },
      listingId: id,
      title: existing.title,
      soldAt: updated.soldAt?.toISOString(),
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, data: toPublic(updated) }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    emitAuditEvent('listing.mark_sold_failed', {
      actor: { type: 'user', id: session.user.id },
      listingId: id,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return jsonError(500, 'failed_to_mark_sold');
  }
}
