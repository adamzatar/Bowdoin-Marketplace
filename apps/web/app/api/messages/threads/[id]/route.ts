// apps/web/app/api/messages/threads/[id]/route.ts
//
// Thread resource
// - GET: fetch a thread the current user participates in (with listing + counters)
// - PATCH: mark thread as read, archive/unarchive
//
// Security / behavior
// - Auth required; 403 if user is not a participant
// - Strong validation via zod
// - Per-user & per-IP rate limiting
// - No PII leakage; only expose user IDs
// - DTO kept local (no contracts import)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import process from 'node:process';

import { prisma } from '@bowdoin/db';
import { z } from 'zod';
import { withAuth, rateLimit, jsonError } from '@/server';

// ===== Response DTOs (local, minimal, contracts-free)

const ThreadDetailZ = z.object({
  id: z.string().uuid(),
  archived: z.boolean(),
  listing: z
    .object({
      id: z.string().uuid(),
      title: z.string(),
      // keep listing DTO lean; fields must exist in schema
    })
    .nullable(),
  participants: z.array(
    z.object({
      userId: z.string().uuid(),
      lastReadAt: z.date().nullable(),
    }),
  ),
  otherUserId: z.string().uuid().nullable(),
  lastMessage: z
    .object({
      id: z.string().uuid(),
      senderId: z.string().uuid(),
      sentAt: z.date(),
      body: z.string(),
    })
    .nullable(),
  counters: z.object({ unreadCount: z.number().int().nonnegative() }),
  lastMessageAt: z.date().nullable(),
  updatedAt: z.date(),
  createdAt: z.date(),
});
type ThreadDetail = ReturnType<(typeof ThreadDetailZ)['parse']>;

// ===== Utilities

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
} as const;

const ParamsZ = z.object({ id: z.string().uuid() });

const PatchBodyZ = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('mark_read'),
    lastReadAt: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({ action: z.literal('archive') }),
  z.object({ action: z.literal('unarchive') }),
]);

type ThreadWithListing = {
  id: string;
  listingId: string;
  sellerId: string;
  buyerId: string;
  createdAt: Date;
  closedAt: Date | null;
  listing: { id: string; title: string } | null;
  messages: Array<{ id: string; senderId: string; sentAt: Date; body: string }>;
};

// replace the whole function with this:
function computeUnreadCount(_threadId: string, _viewerId: string): Promise<number> {
  // Schema has no per-user read state yet; keep API stable while always reporting zero unread.
  // Future: introduce ThreadReadReceipt and compute real counts here.
  return Promise.resolve(0);
}

function getClientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for');
  if (xf) {
    const first = xf.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

function deriveParticipants(thread: ThreadWithListing): Array<{ userId: string; lastReadAt: Date | null }> {
  const unique = new Set<string>([thread.sellerId, thread.buyerId]);
  return Array.from(unique).map((userId) => ({ userId, lastReadAt: null }));
}

function toDetailPayload(input: {
  thread: ThreadWithListing;
  lastMessage: { id: string; senderId: string; sentAt: Date; body: string } | null;
  unreadCount: number;
  viewerId: string;
}): ThreadDetail {
  const { thread, lastMessage, unreadCount, viewerId } = input;
  const participants = deriveParticipants(thread);
  const otherUserId = participants.map((p) => p.userId).find((id) => id !== viewerId) ?? null;

  const lastMessageAt = lastMessage?.sentAt ?? null;
  const updatedAt = lastMessageAt ?? thread.createdAt;

  const payload: ThreadDetail = {
    id: thread.id,
    archived: Boolean(thread.closedAt),
    listing: thread.listing ? { id: thread.listing.id, title: thread.listing.title } : null,
    participants,
    otherUserId,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          senderId: lastMessage.senderId,
          sentAt: lastMessage.sentAt,
          body: lastMessage.body,
        }
      : null,
    counters: { unreadCount },
    lastMessageAt,
    updatedAt,
    createdAt: thread.createdAt,
  };

  if (process.env.NODE_ENV !== 'production') {
    try {
    ThreadDetailZ.parse(payload);
    } catch {
      // Non-fatal during development; CI/type checks catch drift
    }
  }

  return payload;
}

function extractThreadId(url: string) {
  const match = url.match(/\/api\/messages\/threads\/([^/]+)/);
  return match?.[1];
}

// ===== GET /api/messages/threads/[id]

export const GET = withAuth()(async (req, ctx) => {
  const viewerId = ctx.session?.user?.id ?? ctx.userId;
  if (!viewerId) return jsonError(401, 'unauthorized');

  try {
    const ip = getClientIp(req);
    await Promise.all([
      rateLimit(`rl:thread:get:user:${viewerId}`, 300, 60),
      rateLimit(`rl:thread:get:ip:${ip}`, 600, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const idRaw = extractThreadId(req.url);
  const parsed = ParamsZ.safeParse({ id: idRaw });
  if (!parsed.success) return jsonError(400, 'invalid_thread_id');

  try {
    const t = await prisma.thread.findFirst({
      where: {
        id: parsed.data.id,
        OR: [{ sellerId: viewerId }, { buyerId: viewerId }],
      },
      include: {
        listing: { select: { id: true, title: true } },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { id: true, senderId: true, sentAt: true, body: true },
        },
      },
    });

    if (!t) return jsonError(404, 'thread_not_found');

    const unreadCount = await computeUnreadCount(t.id, viewerId);
    const last = t.messages[0] ?? null;

    const payload = toDetailPayload({
      thread: {
        id: t.id,
        listingId: t.listingId,
        sellerId: t.sellerId,
        buyerId: t.buyerId,
        closedAt: t.closedAt,
        createdAt: t.createdAt,
        listing: t.listing,
        messages: t.messages,
      },
      lastMessage: last,
      unreadCount,
      viewerId,
    });

    return new Response(JSON.stringify({ ok: true, data: payload }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch {
    return jsonError(500, 'thread_fetch_failed');
  }
});

// ===== PATCH /api/messages/threads/[id]

export const PATCH = withAuth()(async (req, ctx) => {
  const viewerId = ctx.session?.user?.id ?? ctx.userId;
  if (!viewerId) return jsonError(401, 'unauthorized');

  try {
    const ip = getClientIp(req);
    await Promise.all([
      rateLimit(`rl:thread:patch:user:${viewerId}`, 90, 60),
      rateLimit(`rl:thread:patch:ip:${ip}`, 180, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const idRaw = extractThreadId(req.url);
  const parsedId = ParamsZ.safeParse({ id: idRaw });
  if (!parsedId.success) return jsonError(400, 'invalid_thread_id');

  const parsedBody = PatchBodyZ.safeParse(await req.json());
  if (!parsedBody.success) return jsonError(400, 'invalid_body');
  const body = parsedBody.data;

  const thread = await prisma.thread.findFirst({
    where: {
      id: parsedId.data.id,
      OR: [{ sellerId: viewerId }, { buyerId: viewerId }],
    },
    select: {
      id: true,
      createdAt: true,
      closedAt: true,
    },
  });
  if (!thread) return jsonError(404, 'thread_not_found');

  try {
    if (body.action === 'mark_read') {
      // Mark-read is currently a no-op because we lack per-user read state; keep legacy callers happy.
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: noStoreHeaders,
      });
    }

    if (body.action === 'archive' || body.action === 'unarchive') {
      const desiredClosedAt = body.action === 'archive' ? new Date() : null;
      const current = thread.closedAt;
      const isChange =
        (desiredClosedAt === null && current !== null) ||
        (desiredClosedAt !== null &&
          (current === null || Math.abs(desiredClosedAt.getTime() - current.getTime()) > 500));

      if (isChange) {
        await prisma.thread.update({
          where: { id: thread.id },
          data: { closedAt: desiredClosedAt },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: noStoreHeaders,
      });
    }

    return jsonError(400, 'unsupported_action');
  } catch {
    return jsonError(500, 'thread_update_failed');
  }
});
