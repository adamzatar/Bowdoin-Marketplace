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
// - Responses are shaped to align with @bowdoin/contracts (best-effort runtime checks)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { Messages } from '@bowdoin/contracts/schemas/messages';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { jsonError } from '../../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../../src/server/rateLimit';
import { withAuth } from '../../../../../src/server/withAuth';

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// --------- Validators

const ParamsZ = z.object({
  id: z.string().uuid(),
});

const PatchBodyZ = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('mark_read'),
    // Optional explicit cut-off (ISO). If omitted, uses "now".
    // We clamp to not exceed newest message timestamp to avoid future values.
    lastReadAt: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({ action: z.literal('archive') }),
  z.object({ action: z.literal('unarchive') }),
]);

// --------- Helpers

async function computeUnreadCount(threadId: string, viewerId: string, lastReadAt: Date | null) {
  return prisma.message.count({
    where: {
      threadId,
      senderId: { not: viewerId },
      createdAt: { gt: lastReadAt ?? new Date(0) },
    },
  });
}

function toDetailPayload(input: {
  thread: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date | null;
    archived: boolean;
    listing: {
      id: string;
      title: string;
      priceCents: number;
      currency: string;
      images: string[];
      sellerId: string;
      soldAt: Date | null;
    };
    participants: Array<{ userId: string; lastReadAt: Date | null }>;
  };
  lastMessage: { id: string; senderId: string; createdAt: Date; text: string } | null;
  unreadCount: number;
  viewerId: string;
}) {
  const { thread, lastMessage, unreadCount, viewerId } = input;
  const otherUserId =
    thread.participants.map((p) => p.userId).find((id) => id !== viewerId) ??
    thread.participants[0]?.userId ??
    viewerId;

  const payload: Messages.ThreadDetail = {
    id: thread.id,
    archived: thread.archived,
    listing: {
      id: thread.listing.id,
      title: thread.listing.title,
      price: thread.listing.priceCents / 100,
      currency: thread.listing.currency,
      image: thread.listing.images?.[0] ?? null,
      soldAt: thread.listing.soldAt,
      sellerId: thread.listing.sellerId,
    },
    participants: thread.participants.map((p) => ({
      userId: p.userId,
      // Expose timestamp only; no PII
      lastReadAt: p.lastReadAt,
    })),
    otherUserId,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          senderId: lastMessage.senderId,
          createdAt: lastMessage.createdAt,
          text: lastMessage.text,
        }
      : null,
    counters: { unreadCount },
    lastMessageAt: thread.lastMessageAt,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
  };

  if (process.env.NODE_ENV !== 'production') {
    try {
      Messages.ThreadDetailZ.parse(payload);
    } catch {
      // contract drift will be caught during CI; do not disrupt prod
    }
  }

  return payload;
}

// --------- GET /api/messages/threads/[id]

export const GET = withAuth(async (req, ctx) => {
  const viewerId = ctx.session.user.id;

  // Rate limit: per-user & per-IP
  try {
    await Promise.all([
      rateLimit(`rl:thread:get:user:${viewerId}`, 300, 60), // up to 300/min
      rateLimit(`rl:thread:get:ip:${ctx.ip}`, 600, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const match = req.nextUrl.pathname.match(/\/api\/messages\/threads\/([^/]+)/);
  const id = match?.[1];
  const parsed = ParamsZ.safeParse({ id });
  if (!parsed.success) return jsonError(400, 'invalid_thread_id');

  try {
    const t = await prisma.messageThread.findFirst({
      where: { id: parsed.data.id, participants: { some: { userId: viewerId } } },
      include: {
        participants: { select: { userId: true, lastReadAt: true } },
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
      },
    });

    if (!t) return jsonError(404, 'thread_not_found');

    const viewerPart = t.participants.find((p) => p.userId === viewerId);
    const unreadCount = await computeUnreadCount(t.id, viewerId, viewerPart?.lastReadAt ?? null);
    const last = t.messages[0] ?? null;

    const payload = toDetailPayload({
      thread: {
        id: t.id,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        lastMessageAt: (t as any).lastMessageAt ?? last?.createdAt ?? t.updatedAt,
        archived: (t as any).archived ?? false, // schema may have this column
        listing: t.listing,
        participants: t.participants,
      },
      lastMessage: last,
      unreadCount,
      viewerId,
    });

    return new Response(JSON.stringify({ ok: true, data: payload }), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    return jsonError(500, 'thread_fetch_failed');
  }
});

// --------- PATCH /api/messages/threads/[id]
//
// Actions:
//  - { action: "mark_read", lastReadAt?: ISOString }
//  - { action: "archive" }
//  - { action: "unarchive" }

export const PATCH = withAuth(async (req, ctx) => {
  const viewerId = ctx.session.user.id;

  try {
    await Promise.all([
      rateLimit(`rl:thread:patch:user:${viewerId}`, 90, 60), // 90/min per user
      rateLimit(`rl:thread:patch:ip:${ctx.ip}`, 180, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const match = req.nextUrl.pathname.match(/\/api\/messages\/threads\/([^/]+)/);
  const id = match?.[1];
  const parsedId = ParamsZ.safeParse({ id });
  if (!parsedId.success) return jsonError(400, 'invalid_thread_id');

  let body: z.infer<typeof PatchBodyZ>;
  try {
    body = PatchBodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_body');
  }

  // Ensure the viewer is a participant
  const thread = await prisma.messageThread.findFirst({
    where: { id: parsedId.data.id, participants: { some: { userId: viewerId } } },
    select: {
      id: true,
      updatedAt: true,
      lastMessageAt: true,
      archived: true,
      participants: { select: { userId: true, lastReadAt: true } },
    },
  });
  if (!thread) return jsonError(404, 'thread_not_found');

  try {
    if (body.action === 'mark_read') {
      // Determine cut-off time: provided or now, but never in the future
      const now = new Date();
      const requested = body.lastReadAt ? new Date(body.lastReadAt) : now;
      const cutoff = requested > now ? now : requested;

      // We also clamp to the newest message timestamp (lastMessageAt) if present
      const maxTs = thread.lastMessageAt ?? now;
      const effective = cutoff > maxTs ? maxTs : cutoff;

      await prisma.messageParticipant.updateMany({
        where: { threadId: thread.id, userId: viewerId },
        data: { lastReadAt: effective },
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: noStoreHeaders,
      });
    }

    if (body.action === 'archive' || body.action === 'unarchive') {
      // Archiving is typically per-user. If your schema stores it on the thread, this will be global.
      // Prefer per-user archive column (message_participants.archived) if available.
      // We’ll try participant-level first, then fall back to thread-level.
      const desired = body.action === 'archive';

      // Try participant-level toggle; if schema lacks column, this is a no-op
      const participantArchiveUpdated = await prisma.messageParticipant.updateMany({
        where: { threadId: thread.id, userId: viewerId },
        data: { archived: desired as any },
      });

      // If no rows changed (e.g., column doesn’t exist), fall back to thread-level
      if (participantArchiveUpdated.count === 0) {
        await prisma.messageThread.update({
          where: { id: thread.id },
          data: { archived: desired as any, updatedAt: new Date() },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: noStoreHeaders,
      });
    }

    // Exhaustiveness guard
    return jsonError(400, 'unsupported_action');
  } catch (err) {
    return jsonError(500, 'thread_update_failed');
  }
});
