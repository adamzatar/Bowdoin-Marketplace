// apps/web/app/api/messages/threads/[id]/messages/route.ts
//
// Thread messages collection
// - GET: list messages in a thread (cursor pagination, newest->oldest by sentAt desc)
// - POST: send a message to a thread the viewer participates in
//
// Security / behavior
// - Auth required; 403 if user is not a participant
// - Strict validation via zod
// - Per-user & per-IP rate limiting
// - Basic content sanitation (trim/strip control chars, max length)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { prisma } from '@bowdoin/db';
import { z } from 'zod';

// Local/internal utilities (relative paths to avoid alias resolution issues)
import { withAuth, rateLimit, auditEvent, jsonError } from '@/server';

const JSON_NOSTORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  expires: '0',
  vary: 'Cookie',
} as const;

// ---------- validators

const ParamsZ = z.object({ id: z.string().uuid() });

// cursor format: `${sentAt.toISOString()}_${messageId}`
const CursorZ = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T.*Z_[0-9a-fA-F-]{36}$/u)
  .transform((c: string) => {
    const [iso, id] = c.split('_') as [string, string];
    return { sentAt: new Date(iso), id };
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
  // (avoid "no-control-regex" by filtering via charCode)
  const collapsed = input.replace(/[^\S\r\n\t]+/g, ' ');
  let out = '';
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];
    if (!ch) continue;
    const code = ch.charCodeAt(0);
    // keep \n (10) and \t (9), drop other C0 controls (< 32) and DEL (127)
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    out += ch;
  }
  return out.trim();
}

const __DEV__ =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { process?: { env?: Record<string, string | undefined> } }).process !==
    'undefined' &&
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.
    NODE_ENV !== 'production';

function getIpFromHeaders(req: Request): string {
  const xfwd = req.headers.get('x-forwarded-for');
  if (xfwd) {
    const [first] = xfwd.split(',');
    if (first?.trim()) return first.trim();
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return '0.0.0.0';
}

// Public DTO we return from this route (keeps existing API shape)
type MessageDTO = {
  id: string;
  threadId: string;
  senderId: string;
  text: string;        // mapped from Message.body
  createdAt: Date;     // mapped from Message.sentAt
};

function toDTO(m: {
  id: string;
  threadId: string;
  senderId: string;
  body: string;
  sentAt: Date;
}): MessageDTO {
  const obj: MessageDTO = {
    id: m.id,
    threadId: m.threadId,
    senderId: m.senderId,
    text: m.body,
    createdAt: m.sentAt,
  };

  if (__DEV__) {
    try {
      // If you later wire contracts back, validate here.
      // Messages.MessageZ.parse({ ...obj, createdAt: obj.createdAt.toISOString() }) // example
    } catch {
      // contract drift should be caught by tests/CI
    }
  }

  return obj;
}

// ---------- GET /api/messages/threads/[id]/messages

export const GET = withAuth()(async (req, ctx) => {
  const viewerId = ctx.userId ?? ctx.session?.user?.id;
  if (typeof viewerId !== 'string' || viewerId.length === 0) {
    return jsonError(401, 'unauthorized');
  }
  const ip = getIpFromHeaders(req);
  const url = new URL(req.url);
  const pathname = url.pathname;
  const searchParams = url.searchParams;

  try {
    await Promise.all([
      rateLimit(`rl:msgs:get:user:${viewerId}`, 300, 60),
      rateLimit(`rl:msgs:get:ip:${ip}`, 600, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const match = pathname.match(/\/api\/messages\/threads\/([^/]+)\/messages/);
  const id = match?.[1];
  const p = ParamsZ.safeParse({ id });
  if (!p.success) return jsonError(400, 'invalid_thread_id');

  const q = QueryZ.safeParse({
    limit: searchParams.get('limit') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  });
  if (!q.success) return jsonError(400, 'invalid_query');

  // Ensure viewer participates
  const participation = await prisma.thread.findFirst({
    where: {
      id: p.data.id,
      OR: [{ buyerId: viewerId }, { sellerId: viewerId }],
    },
    select: { id: true },
  });
  if (!participation) return jsonError(404, 'thread_not_found');

  const whereCursor =
    q.data.cursor != null
      ? {
          OR: [
            { sentAt: { lt: q.data.cursor.sentAt } },
            { sentAt: q.data.cursor.sentAt, id: { lt: q.data.cursor.id } },
          ],
        }
      : {};

  try {
    const items = await prisma.message.findMany({
      where: { threadId: p.data.id, ...whereCursor },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: q.data.limit + 1,
      select: { id: true, threadId: true, senderId: true, body: true, sentAt: true },
    });

    const hasMore = items.length > q.data.limit;
    const page = hasMore ? items.slice(0, q.data.limit) : items;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last) {
        nextCursor = `${last.sentAt.toISOString()}_${last.id}`;
      }
    }

    const data = page.map(toDTO);

    return new Response(JSON.stringify({ ok: true, data, nextCursor }), {
      status: 200,
      headers: JSON_NOSTORE,
    });
  } catch {
    return jsonError(500, 'messages_fetch_failed');
  }
});

// ---------- POST /api/messages/threads/[id]/messages

export const POST = withAuth()(async (req, ctx) => {
  const viewerId = ctx.userId ?? ctx.session?.user?.id;
  if (typeof viewerId !== 'string' || viewerId.length === 0) {
    return jsonError(401, 'unauthorized');
  }
  const ip = getIpFromHeaders(req);
  const url = new URL(req.url);
  const pathname = url.pathname;

  try {
    await Promise.all([
      rateLimit(`rl:msgs:post:user:${viewerId}`, 30, 60),
      rateLimit(`rl:msgs:post:ip:${ip}`, 60, 60),
    ]);
  } catch {
    return jsonError(429, 'Too many requests');
  }

  const match = pathname.match(/\/api\/messages\/threads\/([^/]+)\/messages/);
  const id = match?.[1];
  const p = ParamsZ.safeParse({ id });
  if (!p.success) return jsonError(400, 'invalid_thread_id');

  const parsedBody = PostBodyZ.safeParse(await req.json());
  if (!parsedBody.success) return jsonError(400, 'invalid_body');
  const bodyParsed = parsedBody.data;

  const text = sanitizeMessage(bodyParsed.text);
  if (text.length === 0) return jsonError(400, 'empty_message');

  // Ensure viewer participates
  const thread = await prisma.thread.findFirst({
    where: {
      id: p.data.id,
      OR: [{ buyerId: viewerId }, { sellerId: viewerId }],
    },
    select: { id: true },
  });
  if (!thread) return jsonError(404, 'thread_not_found');

  try {
    const created = await prisma.$transaction(async (tx) =>
      tx.message.create({
        data: {
          threadId: thread.id,
          senderId: viewerId,
          body: text, // DB field
          ...(bodyParsed.optimisticId ? { id: bodyParsed.optimisticId } : {}),
        },
        select: { id: true, threadId: true, senderId: true, body: true, sentAt: true },
      }),
    );

    try {
      await auditEvent('message.sent', {
        actor: { id: viewerId },
        target: { type: 'thread', id: created.threadId },
        meta: { messageId: created.id, length: created.body.length },
        req: { ip, route: pathname },
        outcome: 'success',
      });
    } catch {
      // ignore audit failures
    }

    const payload = toDTO(created);

    return new Response(JSON.stringify({ ok: true, data: payload }), {
      status: 201,
      headers: JSON_NOSTORE,
    });
  } catch (err: unknown) {
    // Unique violation on optimisticId should be treated as idempotent-success
    const code = (err as { code?: string; message?: string })?.code;
    const msg = (err as { message?: string })?.message ?? '';
    if (code === 'P2002' || /unique/i.test(msg)) {
      const existing = await prisma.message.findFirst({
        where: { id: bodyParsed.optimisticId ?? '' },
        select: { id: true, threadId: true, senderId: true, body: true, sentAt: true },
      });
      if (existing) {
        return new Response(JSON.stringify({ ok: true, data: toDTO(existing) }), {
          status: 200,
          headers: JSON_NOSTORE,
        });
      }
    }
    return jsonError(500, 'message_create_failed');
  }
});
