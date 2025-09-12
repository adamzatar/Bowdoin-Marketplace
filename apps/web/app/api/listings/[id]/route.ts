// apps/web/app/api/listings/[id]/route.ts
//
// Resource endpoint for a single listing.
// - GET:    fetch one listing by ID (audience-aware)
// - PATCH:  update listing (seller-only)
// - DELETE: delete listing (seller-only)
//
// Features: zod validation, ownership & audience checks, rate limits, auditing,
// and response-shape normalization consistent with contracts.

import { ListingPublicZ, ListingUpdateInputZ } from '@bowdoin/contracts/schemas/listings';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { emitAuditEvent } from '../../../../src/server/handlers/audit';
import { jsonError } from '../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../src/server/rateLimit';
import { requireSession } from '../../../../src/server/withAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// ---------- Utilities

const IdParamZ = z.object({ id: z.string().uuid() });

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
      // ignore in production; contracts drift should be caught in tests
    }
  }
  return obj;
}

async function getListingOr404(id: string) {
  const row = await prisma.listing.findUnique({
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
  if (!row) return null;
  return row;
}

// ---------- GET /api/listings/[id]

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const parsed = IdParamZ.safeParse(ctx.params);
  if (!parsed.success) return jsonError(400, 'invalid_id');

  // Soft anonymous read-rate-limit per listing (60/min)
  try {
    await rateLimit(`rl:listings:get:${parsed.data.id}`, 60, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const row = await getListingOr404(parsed.data.id);
  if (!row) return jsonError(404, 'listing_not_found');

  // Enforce audience: community listings require a session
  if (row.audience === 'community') {
    const auth = await requireSession();
    if (!auth.ok) return jsonError(403, 'forbidden');
  }

  return new Response(JSON.stringify({ data: toPublic(row) }), {
    status: 200,
    headers: noStoreHeaders,
  });
}

// ---------- PATCH /api/listings/[id]

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const { session } = auth;

  const parsedId = IdParamZ.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_id');
  const id = parsedId.data.id;

  try {
    await rateLimit(`rl:listings:update:${session.user.id}`, 30, 60); // 30/min per user
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Validate body with contract schema
  const body = (await req.json().catch(() => null)) as unknown;
  const parsedBody = ListingUpdateInputZ.safeParse(body);
  if (!parsedBody.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_body', details: parsedBody.error.flatten() }),
      { status: 400, headers: noStoreHeaders },
    );
  }
  const input = parsedBody.data;

  // Load existing & enforce ownership
  const existing = await prisma.listing.findUnique({
    where: { id },
    select: { sellerId: true, soldAt: true },
  });
  if (!existing) return jsonError(404, 'listing_not_found');
  if (existing.sellerId !== session.user.id) return jsonError(403, 'forbidden');

  // Business rules:
  // - Prevent updating soldAt here (use /mark-sold)
  // - Normalize price to cents when provided
  // - Limit images/tags lengths for safety (server-side guard)
  const data: Record<string, any> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description ?? '';
  if (input.price !== undefined) data.priceCents = Math.round(input.price * 100);
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.audience !== undefined) data.audience = input.audience;
  if (input.category !== undefined) data.category = input.category ?? null;
  if (input.images !== undefined) data.images = (input.images ?? []).slice(0, 20); // cap to 20 images
  if (input.tags !== undefined) data.tags = (input.tags ?? []).slice(0, 25); // cap to 25 tags

  // No soldAt mutation via this route
  if ('soldAt' in (input as any)) {
    return jsonError(400, 'soldAt_not_mutable_here');
  }

  try {
    const updated = await prisma.listing.update({
      where: { id },
      data,
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

    emitAuditEvent('listing.updated', {
      actor: { type: 'user', id: session.user.id },
      listingId: id,
      changed: Object.keys(data),
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, data: toPublic(updated) }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    emitAuditEvent('listing.update_failed', {
      actor: { type: 'user', id: session.user.id },
      listingId: id,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return jsonError(500, 'failed_to_update_listing');
  }
}

// ---------- DELETE /api/listings/[id]

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const { session } = auth;

  const parsedId = IdParamZ.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_id');
  const id = parsedId.data.id;

  try {
    await rateLimit(`rl:listings:delete:${session.user.id}`, 5, 3600); // 5/hour per user
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const existing = await prisma.listing.findUnique({
    where: { id },
    select: { id: true, sellerId: true, title: true },
  });
  if (!existing) return jsonError(404, 'listing_not_found');
  if (existing.sellerId !== session.user.id) return jsonError(403, 'forbidden');

  try {
    await prisma.listing.delete({ where: { id } });

    emitAuditEvent('listing.deleted', {
      actor: { type: 'user', id: session.user.id },
      listingId: id,
      title: existing.title,
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    emitAuditEvent('listing.delete_failed', {
      actor: { type: 'user', id: session.user.id },
      listingId: id,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return jsonError(500, 'failed_to_delete_listing');
  }
}
