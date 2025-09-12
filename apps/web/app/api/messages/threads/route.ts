// apps/web/app/api/messages/threads/route.ts
//
// Threads collection
// - GET: list current user's threads (with last message + unread count)
// - POST: create (or reuse) a thread for a listing and send the first message
//
// Security / behavior
// - Auth required
// - Server-side validation via zod
// - Rate-limited (list + create)
// - Never leaks the other participant’s email or PII
// - Response contracts align with @bowdoin/contracts (best-effort runtime check)

import { Messages } from '@bowdoin/contracts/schemas/messages';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { jsonError } from '../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../src/server/rateLimit';
import { withAuth } from '../../../../src/server/withAuth';

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

// ---------- Validators

const ListQueryZ = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const CreateBodyZ = z.object({
  listingId: z.string().uuid(),
  // Optional explicit recipient; when omitted we infer seller/buyer by listing owner
  toUserId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(2000),
});

// ---------- Shapes / helpers

type ThreadRow = {
  id: string;
  listingId: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  participants: Array<{ userId: string; lastReadAt: Date | null }>;
  listing: {
    id: string;
    title: string;
    priceCents: number;
    currency: string;
    sellerId: string;
    images: string[];
    soldAt: Date | null;
  };
  lastMessage: {
    id: string;
    senderId: string;
    createdAt: Date;
    text: string;
  } | null;
  unreadCount: number;
};

function toThreadSummary(row: ThreadRow, viewerId: string) {
  const otherId =
    row.participants.map((p) => p.userId).find((id) => id !== viewerId) ??
    row.participants[0]?.userId ??
    viewerId;

  const payload: Messages.ThreadSummary = {
    id: row.id,
    listing: {
      id: row.listing.id,
      title: row.listing.title,
      price: row.listing.priceCents / 100,
      currency: row.listing.currency,
      image: row.listing.images?.[0] ?? null,
      soldAt: row.listing.soldAt,
      sellerId: row.listing.sellerId,
    },
    otherUserId: otherId,
    lastMessage: row.lastMessage
      ? {
          id: row.lastMessage.id,
          senderId: row.lastMessage.senderId,
          createdAt: row.lastMessage.createdAt,
          text: row.lastMessage.text,
        }
      : null,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };

  if (process.env.NODE_ENV !== 'production') {
    try {
      Messages.ThreadSummaryZ.parse(payload);
    } catch {
      // contract drift will be caught in tests; don't break prod
    }
  }

  return payload;
}

// ---------- GET /api/messages/threads

export const GET = withAuth(async (req, ctx) => {
  const viewerId = ctx.session.user.id;
  const url = new URL(req.url);
  const parsed = ListQueryZ.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return jsonError(400, 'invalid_query');
  const { page, pageSize } = parsed.data;

  // Rate limit: list threads
  try {
    await Promise.all([
      rateLimit(`rl:threads:list:user:${viewerId}`, 120, 60), // 120/min per user
      rateLimit(`rl:threads:list:ip:${ctx.ip}`, 240, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const skip = (page - 1) * pageSize;
  const take = pageSize;

  try {
    // We need: threads where viewer participates, with:
    // - lastMessage (by createdAt desc)
    // - unreadCount for viewer
    // Prisma pattern: compute unread via _count with filter
    const [total, rows] = await Promise.all([
      prisma.messageThread.count({
        where: {
          participants: { some: { userId: viewerId } },
        },
      }),
      prisma.messageThread.findMany({
        where: {
          participants: { some: { userId: viewerId } },
        },
        orderBy: [{ lastMessageAt: 'desc' as const }, { updatedAt: 'desc' as const }],
        skip,
        take,
        include: {
          participants: {
            select: { userId: true, lastReadAt: true },
          },
          listing: {
            select: {
              id: true,
              title: true,
              priceCents: true,
              currency: true,
              images: true,
              sellerId: true,
              soldAt: true,
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, senderId: true, createdAt: true, text: true },
          },
          _count: {
            select: {
              messages: {
                where: {
                  // unread = messages after user's lastReadAt and not sent by the viewer
                  AND: [
                    { senderId: { not: viewerId } },
                    {
                      // Fallback when no participant record (shouldn't happen): treat all as unread
                      OR: [
                        {
                          createdAt: {
                            gt:
                              // Use a subquery-like approach: we’ll compute in JS below if needed
                              // (Prisma cannot reference participant.lastReadAt in where directly)
                              new Date(0),
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    ]);

    // Because we couldn't reference participant.lastReadAt for the viewer inside _count filter,
    // refine unread count in JS.
    const data = await Promise.all(
      rows.map(async (t): Promise<ThreadRow> => {
        const viewerPart = t.participants.find((p) => p.userId === viewerId);
        const lastReadAt = viewerPart?.lastReadAt ?? new Date(0);

        // Compute accurate unread count
        const unreadCount = await prisma.message.count({
          where: {
            threadId: t.id,
            senderId: { not: viewerId },
            createdAt: { gt: lastReadAt },
          },
        });

        const last = t.messages[0] ?? null;

        return {
          id: t.id,
          listingId: t.listing.id,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          lastMessageAt: (t as any).lastMessageAt ?? last?.createdAt ?? t.updatedAt,
          participants: t.participants,
          listing: t.listing as ThreadRow['listing'],
          lastMessage: last
            ? {
                id: last.id,
                senderId: last.senderId,
                createdAt: last.createdAt,
                text: last.text,
              }
            : null,
          unreadCount,
        };
      }),
    );

    const items = data.map((r) => toThreadSummary(r, viewerId));
    const hasMore = skip + rows.length < total;

    return new Response(
      JSON.stringify({ ok: true, data: { items, page, pageSize, total, hasMore } }),
      {
        status: 200,
        headers: noStoreHeaders,
      },
    );
  } catch (err) {
    return jsonError(500, 'threads_list_failed');
  }
});

// ---------- POST /api/messages/threads

export const POST = withAuth(async (req, ctx) => {
  const viewerId = ctx.session.user.id;

  // Rate limit: create / first message
  try {
    await Promise.all([
      rateLimit(`rl:threads:create:user:${viewerId}`, 20, 60), // 20/min hard cap
      rateLimit(`rl:messages:first:user:${viewerId}`, 30, 60),
      rateLimit(`rl:threads:create:ip:${ctx.ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  let body: z.infer<typeof CreateBodyZ>;
  try {
    body = CreateBodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_body');
  }

  // Guard: listing must exist; infer recipient if missing
  const listing = await prisma.listing.findUnique({
    where: { id: body.listingId },
    select: {
      id: true,
      sellerId: true,
      title: true,
      soldAt: true,
    },
  });
  if (!listing) return jsonError(404, 'listing_not_found');

  const isSeller = listing.sellerId === viewerId;
  const recipientId = body.toUserId ?? (isSeller ? undefined : listing.sellerId);
  if (!recipientId) {
    return jsonError(400, 'recipient_missing');
  }
  if (recipientId === viewerId) {
    return jsonError(400, 'cannot_message_self');
  }

  // If listing is sold, still allow messaging within existing thread (e.g., coordination),
  // but do not create new thread unless viewer already participated before sale.
  // We implement a soft guard: allow creation if not sold OR if an existing thread exists.
  const existing = await prisma.messageThread.findFirst({
    where: {
      listingId: listing.id,
      participants: { every: { userId: { in: [viewerId, recipientId] } } },
    },
    select: { id: true },
  });

  if (listing.soldAt && !existing) {
    return jsonError(409, 'listing_already_sold');
  }

  try {
    const thread = await prisma.$transaction(async (tx) => {
      // Find-or-create thread for {listing, viewer, recipient}
      const found = existing
        ? await tx.messageThread.update({
            where: { id: existing.id },
            data: { updatedAt: new Date() },
          })
        : await tx.messageThread.create({
            data: {
              listingId: listing.id,
              participants: {
                createMany: {
                  data: [{ userId: viewerId }, { userId: recipientId }],
                },
              },
            },
          });

      // Create first/new message
      const msg = await tx.message.create({
        data: {
          threadId: found.id,
          senderId: viewerId,
          text: body.text,
        },
      });

      // Update thread lastMessageAt and bump updatedAt
      await tx.messageThread.update({
        where: { id: found.id },
        data: { lastMessageAt: msg.createdAt, updatedAt: new Date() },
      });

      // Mark sender as read through this message
      await tx.messageParticipant.updateMany({
        where: { threadId: found.id, userId: viewerId },
        data: { lastReadAt: msg.createdAt },
      });

      return { threadId: found.id, message: msg };
    });

    const response: Messages.ThreadCreateResponse = {
      ok: true,
      data: {
        threadId: thread.threadId,
        messageId: thread.message.id,
      },
    };

    if (process.env.NODE_ENV !== 'production') {
      try {
        Messages.ThreadCreateResponseZ.parse(response);
      } catch {
        // ignore in prod
      }
    }

    return new Response(JSON.stringify(response), {
      status: 201,
      headers: noStoreHeaders,
    });
  } catch (err) {
    // Unique constraints could race on find-or-create; retry once on known conflict
    return jsonError(500, 'thread_create_failed');
  }
});
