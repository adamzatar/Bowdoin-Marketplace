// apps/web/app/api/messages/threads/route.ts
//
// Threads collection
// - GET: list current user's threads (with last message summary)
// - POST: create (or reuse) a thread for a listing and send the first message
//
// Security / behavior
// - Auth required
// - Server-side validation via zod
// - Rate-limited (list + create)
// - Never leaks the other participant’s PII

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import { withAuth, rateLimit, Handlers } from '@/src/server';
import type { Session } from '@/src/server';

const { jsonError } = Handlers;

import type { Prisma } from '@prisma/client';

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

const withStrictAuth = withAuth<{ params?: Record<string, string>; ip: string }>();

// ---------- Validators

const ListQueryZ = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const CreateBodyZ = z.object({
  listingId: z.string().uuid(),
  toUserId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(2000),
});

// ---------- Helpers

type MaybeSessionUser = Session['user'];

type ThreadSummary = {
  id: string;
  listing: {
    id: string;
    title: string;
    price: number;
    sellerId: string;
  } | null;
  otherUserId: string;
  lastMessage: {
    id: string;
    senderId: string;
    sentAt: Date;
    text: string;
  } | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

function ensureUser(user: MaybeSessionUser | undefined): user is NonNullable<MaybeSessionUser> {
  return Boolean(user?.id);
}

function toThreadSummary(
  thread: {
    id: string;
    listing: {
      id: string;
      title: string;
      price: unknown;
      userId: string;
    } | null;
    buyerId: string;
    sellerId: string;
    createdAt: Date;
    messages: Array<{ id: string; senderId: string; sentAt: Date; body: string }>;
  },
  viewerId: string,
): ThreadSummary {
  const last = thread.messages[0] ?? null;
  const otherUserId = viewerId === thread.sellerId ? thread.buyerId : thread.sellerId;

  const listing = thread.listing
    ? {
        id: thread.listing.id,
        title: thread.listing.title,
        price: typeof thread.listing.price === 'number'
          ? thread.listing.price
          : Number(thread.listing.price ?? 0),
        sellerId: thread.sellerId,
      }
    : null;

  return {
    id: thread.id,
    listing,
    otherUserId,
    lastMessage: last
      ? {
          id: last.id,
          senderId: last.senderId,
          sentAt: last.sentAt,
          text: last.body,
        }
      : null,
    unreadCount: 0,
    lastMessageAt: last?.sentAt ?? null,
    updatedAt: last?.sentAt ?? thread.createdAt,
    createdAt: thread.createdAt,
  };
}

// ---------- GET /api/messages/threads

export const GET = withStrictAuth(async (req, ctx) => {
  const user = ctx.session?.user;
  if (!ensureUser(user)) return jsonError(403, 'forbidden');
  const viewerId = String(user.id);

  try {
    await Promise.all([
      rateLimit(`rl:threads:list:user:${viewerId}`, 120, 60),
      rateLimit(`rl:threads:list:ip:${ctx.ip}`, 240, 60),
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  const url = new URL(req.url);
  const parsed = ListQueryZ.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return jsonError(400, 'invalid_query');
  const { page, pageSize } = parsed.data;

  const skip = (page - 1) * pageSize;
  const take = pageSize;

  const where: Prisma.ThreadWhereInput = {
    OR: [{ buyerId: viewerId }, { sellerId: viewerId }],
  };

  try {
    const [total, rows] = await Promise.all([
      prisma.thread.count({ where }),
      prisma.thread.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              price: true,
              userId: true,
            },
          },
          messages: {
            orderBy: { sentAt: 'desc' },
            take: 1,
            select: { id: true, senderId: true, sentAt: true, body: true },
          },
        },
      }),
    ]);

    const items = rows.map((thread) => toThreadSummary(thread, viewerId));
    const hasMore = skip + rows.length < total;

    return new Response(
      JSON.stringify({ ok: true, data: { items, page, pageSize, total, hasMore } }),
      {
        status: 200,
        headers: noStoreHeaders,
      },
    );
  } catch {
    return jsonError(500, 'threads_list_failed');
  }
});

// ---------- POST /api/messages/threads

export const POST = withStrictAuth(async (req, ctx) => {
  const user = ctx.session?.user;
  if (!ensureUser(user)) return jsonError(403, 'forbidden');
  const viewerId = String(user.id);

  try {
    await Promise.all([
      rateLimit(`rl:threads:create:user:${viewerId}`, 20, 60),
      rateLimit(`rl:messages:first:user:${viewerId}`, 30, 60),
      rateLimit(`rl:threads:create:ip:${ctx.ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'too_many_requests');
  }

  let body: z.infer<typeof CreateBodyZ>;
  try {
    body = CreateBodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_body');
  }

  const listing = await prisma.listing.findUnique({
    where: { id: body.listingId },
    select: { id: true, userId: true },
  });
  if (!listing) return jsonError(404, 'listing_not_found');

  const sellerId = listing.userId;
  const isSeller = sellerId === viewerId;
  const buyerId = isSeller ? body.toUserId : viewerId;

  if (!buyerId) return jsonError(400, 'recipient_missing');
  if (buyerId === sellerId) return jsonError(400, 'cannot_message_self');

  try {
    const thread = await prisma.thread.upsert({
      where: {
        listingId_buyerId: {
          listingId: listing.id,
          buyerId,
        },
      },
      update: {},
      create: {
        listingId: listing.id,
        sellerId,
        buyerId,
      },
      select: { id: true },
    });

    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        senderId: viewerId,
        body: body.text,
      },
      select: { id: true },
    });

    return new Response(
      JSON.stringify({ ok: true, data: { threadId: thread.id, messageId: message.id } }),
      {
        status: 201,
        headers: noStoreHeaders,
      },
    );
  } catch {
    return jsonError(500, 'thread_create_failed');
  }
});
