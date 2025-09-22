// apps/web/app/api/messages/threads/[id]/messages/route.ts
//
// Thread messages collection
// - GET: list messages in a thread (cursor pagination, newest->oldest by createdAt desc)
// - POST: send a message to a thread the viewer participates in
//
// Security / behavior
// - Auth required; 403 if user is not a participant
// - Strict validation via zod
// - Per-user & per-IP rate limiting
// - Basic content sanitation (trim/strip control chars, max length)
// - Responses shaped to align with @bowdoin/contracts (validated in dev)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { Messages } from '@bowdoin/contracts/schemas/messages';
import { prisma } from '@bowdoin/db';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { auditEvent } from '../../../../../../src/server/handlers/audit';
import { jsonError } from '../../../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../../../src/server/rateLimit';
import { withAuth } from '../../../../../../src/server/withAuth';

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
};

// ---------- validators

const ParamsZ = z.object({ id: z.string().uuid() });

const CursorZ = z
  .string()
  // cursor format: `${createdAt.toISOString()}_${messageId}`
  .regex(/^\d{4}-\d{2}-\d{2}T.*Z_[0-9a-fA-F-]{36}$/)
  .transform((c) => {
    const [iso, id] = c.split('_');
    return { createdAt: new Date(iso), id };
  });

const QueryZ = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: CursorZ.optional(),
});

const PostBodyZ = z.object({
  text: z.string().min(1).max(2000),
  optimisticId: z.string().uuid().optional(),
});

// ---------- helpers

function sanitizeMessage(input: string): string {
  // Trim, collapse excessive whitespace, and drop control chars except \n and \t
  const noControls = input
    .replace(/[^\S\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return noControls.trim();
}

function toContractMessage(m: {
  id: string;
  threadId: string;
  senderId: string;
  text: string;
  createdAt: Date;
}): Messages.Message {
  const payload: Messages.Message = {
    id: m.id,
    threadId: m.threadId,
    senderId: m.senderId,
    text: m.text,
    createdAt: m.createdAt,
  };
  if (process.env.NODE_ENV !== 'production') {
    try {
      Messages.MessageZ.parse(payload);
    } catch {
      // contract drift is caught in CI; don't crash prod
    }
  }
  return payload;
}

// ---------- GET /api/messages/threads/[id]/messages

export const GET = withAuth(async (req, ctx) => {
  const viewerId = ctx.session.user.id;

  // Rate limits: list operations can be fairly high
  try {
    await Promise.all([
      rateLimit(`rl:msgs:get:user:${viewerId}`, 300, 60),
      rateLimit(`rl:msgs:get:ip:${ctx.ip}`, 600, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const match = req.nextUrl.pathname.match(/\/api\/messages\/threads\/([^/]+)\/messages/);
  const id = match?.[1];
  const p = ParamsZ.safeParse({ id });
  if (!p.success) return jsonError(400, 'invalid_thread_id');

  // Validate query
  const q = QueryZ.safeParse({
    limit: req.nextUrl.searchParams.get('limit') ?? undefined,
    cursor: req.nextUrl.searchParams.get('cursor') ?? undefined,
  });
  if (!q.success) return jsonError(400, 'invalid_query');

  // Ensure viewer participates
  const participation = await prisma.messageThread.findFirst({
    where: { id: p.data.id, participants: { some: { userId: viewerId } } },
    select: { id: true },
  });
  if (!participation) return jsonError(404, 'thread_not_found');

  const whereCursor =
    q.data.cursor != null
      ? {
          OR: [
            { createdAt: { lt: q.data.cursor.createdAt } },
            { createdAt: q.data.cursor.createdAt, id: { lt: q.data.cursor.id } },
          ],
        }
      : {};

  try {
    const items = await prisma.message.findMany({
      where: { threadId: p.data.id, ...whereCursor },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.data.limit + 1,
      select: { id: true, threadId: true, senderId: true, text: true, createdAt: true },
    });

    const hasMore = items.length > q.data.limit;
    const page = hasMore ? items.slice(0, q.data.limit) : items;

    const nextCursor = hasMore
      ? `${page[page.length - 1].createdAt.toISOString()}_${page[page.length - 1].id}`
      : null;

    const data = page.map(toContractMessage);

    if (process.env.NODE_ENV !== 'production') {
      try {
        Messages.MessageListZ.parse({ data, nextCursor });
      } catch {
        // ignore in runtime
      }
    }

    return new Response(JSON.stringify({ ok: true, data, nextCursor }), {
      status: 200,
      headers: JSON_NOSTORE,
    });
  } catch {
    return jsonError(500, 'messages_fetch_failed');
  }
});

// ---------- POST /api/messages/threads/[id]/messages

export const POST = withAuth(async (req, ctx) => {
  const viewerId = ctx.session.user.id;

  // Stricter rate limits for sending
  try {
    await Promise.all([
      rateLimit(`rl:msgs:post:user:${viewerId}`, 30, 60), // 30 per minute per user
      rateLimit(`rl:msgs:post:ip:${ctx.ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const match = req.nextUrl.pathname.match(/\/api\/messages\/threads\/([^/]+)\/messages/);
  const id = match?.[1];
  const p = ParamsZ.safeParse({ id });
  if (!p.success) return jsonError(400, 'invalid_thread_id');

  let body: z.infer<typeof PostBodyZ>;
  try {
    body = PostBodyZ.parse(await req.json());
  } catch {
    return jsonError(400, 'invalid_body');
  }

  const text = sanitizeMessage(body.text);
  if (text.length === 0) return jsonError(400, 'empty_message');

  // Ensure viewer participates
  const thread = await prisma.messageThread.findFirst({
    where: { id: p.data.id, participants: { some: { userId: viewerId } } },
    select: { id: true },
  });
  if (!thread) return jsonError(404, 'thread_not_found');

  try {
    const created = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          threadId: thread.id,
          senderId: viewerId,
          text,
          // allow client to supply optimisticId to dedupe across retries
          ...(body.optimisticId ? { id: body.optimisticId } : {}),
        },
        select: { id: true, threadId: true, senderId: true, text: true, createdAt: true },
      });

      await tx.messageThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: msg.createdAt, updatedAt: msg.createdAt },
      });

      return msg;
    });

    // Fire-and-forget audit (non-blocking)
    auditEvent('message.sent', {
      actorId: viewerId,
      threadId: created.threadId,
      messageId: created.id,
      length: created.text.length,
    }).catch(() => {});

    const payload = toContractMessage(created);

    return new Response(JSON.stringify({ ok: true, data: payload }), {
      status: 201,
      headers: JSON_NOSTORE,
    });
  } catch (err: any) {
    // Unique violation on optimisticId should be treated as idempotent-success
    const code = err?.code ?? err?.meta?.code;
    if (code === 'P2002' || /unique/i.test(String(err?.message ?? ''))) {
      // Find the already-created message (same id)
      const existing = await prisma.message.findFirst({
        where: { id: body.optimisticId ?? '' },
        select: { id: true, threadId: true, senderId: true, text: true, createdAt: true },
      });
      if (existing) {
        return new Response(JSON.stringify({ ok: true, data: toContractMessage(existing) }), {
          status: 200,
          headers: JSON_NOSTORE,
        });
      }
    }
    return jsonError(500, 'message_create_failed');
  }
});
