// apps/web/app/api/listings/[id]/route.ts

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { requireSession, rateLimit, Handlers } from '@/src/server';

const { auditEvent, jsonError } = Handlers;

// type-only import placed after local imports to satisfy import/order
import type { NextRequest } from 'next/server';

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// ---------- Utilities

// Local schema to avoid unresolved subpath import issues
const ListingIdSchema = z.string().uuid();
const ListingParamsSchema = z.object({ id: ListingIdSchema });

function unauthorizedJson(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: noStoreHeaders,
  });
}

type AudienceValue = 'CAMPUS' | 'PUBLIC';

const PRISMA_AUDIENCE: Record<'campus' | 'public', AudienceValue> = {
  campus: 'CAMPUS',
  public: 'PUBLIC',
};

type ListingRow = {
  id: string;
  title: string;
  description: string | null;
  price: unknown; // Prisma.Decimal | number | string (serialize-safe)
  isFree: boolean;
  condition: string | null;
  category: string | null;
  location: string | null;
  audience: AudienceValue;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  status: string; // ListingStatus
};

function numFromDecimalLike(v: unknown): number {
  if (v && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v ?? 0);
}

function toPublic(listing: ListingRow) {
  const price = numFromDecimalLike(listing.price);
  const priceCents = Math.round(price * 100);
  const currency = 'USD' as const;
  const sellerId = listing.userId;
  const audienceOut = listing.audience === PRISMA_AUDIENCE.public ? 'public' : 'campus';

  return {
    id: listing.id,
    title: listing.title,
    description: listing.description ?? '',
    price,
    priceCents,
    currency,
    isFree: listing.isFree,
    condition: listing.condition,
    category: listing.category,
    location: listing.location,
    audience: audienceOut,
    images: [] as string[],
    tags: [] as string[],
    sellerId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    soldAt: null as Date | null,
    status: listing.status,
  };
}

async function getListingOr404(id: string): Promise<ListingRow | null> {
  const row = await prisma.listing.findUnique({
    where: { id },
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
  });
  return row ?? null;
}

// ---------- GET /api/listings/[id]

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const parsed = ListingParamsSchema.safeParse(ctx.params);
  if (!parsed.success) return jsonError(400, 'invalid_id');

  const id: string = parsed.data.id;

  try {
    await rateLimit(`rl:listings:get:${id}`, 60, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const row = await getListingOr404(id);
  if (!row) return jsonError(404, 'listing_not_found');

  // In your current model, CAMPUS = Bowdoin-only; PUBLIC = everyone.
  if (row.audience === PRISMA_AUDIENCE.campus) {
    const auth = await requireSession();
    if (!auth.ok) return auth.error;
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
  const session = auth.session;
  if (!session || !session.user || !session.user.id) {
    return unauthorizedJson();
  }
  const userId = session.user.id as string;

  const parsedId = ListingParamsSchema.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_id');
  const id: string = parsedId.data.id;

  try {
    await rateLimit(`rl:listings:update:${userId}`, 30, 60);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Accept a minimal JSON payload; your old schema referenced contracts.
  const BodyZ = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    price: z.number().min(0).max(1_000_000).optional(),
    audience: z.enum(['public', 'campus']).optional(),
    category: z.string().max(120).nullable().optional(),
    location: z.string().max(120).nullable().optional(),
    isFree: z.boolean().optional(),
    condition: z.string().nullable().optional(),
    // ignore images/tags/soldAt here (not present in schema)
  });

  const raw = (await req.json().catch(() => null)) as unknown;
  const parsedBody = BodyZ.safeParse(raw);
  if (!parsedBody.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_body', details: parsedBody.error.flatten() }),
      { status: 400, headers: noStoreHeaders },
    );
  }
  const input = parsedBody.data;

  const existing = await prisma.listing.findUnique({
    where: { id },
    select: { userId: true, status: true },
  });
  if (!existing) return jsonError(404, 'listing_not_found');
  if (existing.userId !== userId) return jsonError(403, 'forbidden');

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description ?? '';
  if (input.price !== undefined) data.price = input.price; // Decimal handled by Prisma
  if (input.category !== undefined) data.category = input.category ?? null;
  if (input.location !== undefined) data.location = input.location ?? null;
  if (input.isFree !== undefined) data.isFree = input.isFree;
  if (input.condition !== undefined) data.condition = input.condition ?? null;
  if (input.audience !== undefined) {
    data.audience =
      input.audience === 'public' ? PRISMA_AUDIENCE.public : PRISMA_AUDIENCE.campus;
  }

  try {
    const updated = await prisma.listing.update({
      where: { id },
      data,
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
    });

    await auditEvent.emit(
      'listing.updated',
      {
        actor: { type: 'user', id: userId },
        listingId: id,
        changed: Object.keys(data),
      },
      { req, userId },
    );

    return new Response(JSON.stringify({ ok: true, data: toPublic(updated) }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    await auditEvent.emit(
      'listing.update_failed',
      {
        actor: { type: 'user', id: userId },
        listingId: id,
        error: err instanceof Error ? err.message : String(err),
      },
      { req, userId },
    );
    return jsonError(500, 'failed_to_update_listing');
  }
}

// ---------- DELETE /api/listings/[id]

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const session = auth.session;
  if (!session || !session.user || !session.user.id) {
    return unauthorizedJson();
  }
  const userId = session.user.id as string;

  const parsedId = ListingParamsSchema.safeParse(ctx.params);
  if (!parsedId.success) return jsonError(400, 'invalid_id');
  const id: string = parsedId.data.id;

  try {
    await rateLimit(`rl:listings:delete:${userId}`, 5, 3600);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const existing = await prisma.listing.findUnique({
    where: { id },
    select: { id: true, userId: true, title: true },
  });
  if (!existing) return jsonError(404, 'listing_not_found');
  if (existing.userId !== userId) return jsonError(403, 'forbidden');

  try {
    await prisma.listing.delete({ where: { id } });

    await auditEvent.emit(
      'listing.deleted',
      {
        actor: { type: 'user', id: userId },
        listingId: id,
        title: existing.title,
      },
      { req: _req, userId },
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    await auditEvent.emit(
      'listing.delete_failed',
      {
        actor: { type: 'user', id: userId },
        listingId: id,
        error: err instanceof Error ? err.message : String(err),
      },
      { req: _req, userId },
    );
    return jsonError(500, 'failed_to_delete_listing');
  }
}
