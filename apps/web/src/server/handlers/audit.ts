// apps/web/src/server/handlers/audit.ts
import { audit } from '@bowdoin/observability';

type Maybe<T> = T | undefined;

export type AuditCtx = {
  req?: Maybe<Request>;
  userId?: Maybe<string>;
  sessionId?: Maybe<string>;
  route?: Maybe<string>;
  extra?: Record<string, unknown>;
};

export type AuditPayload = Record<string, unknown>;

/* ─────────────────────────── internals ─────────────────────────── */

function header(req: Request | undefined, key: string): string | undefined {
  const v = req?.headers.get(key);
  return v ?? undefined;
}

function firstForwarded(ipList: string | undefined): string | undefined {
  if (!ipList) return undefined;
  const first = ipList.split(',')[0]?.trim();
  return first || undefined;
}

function buildMeta(ctx?: AuditCtx) {
  const req = ctx?.req;
  const url = req ? new URL(req.url) : undefined;

  const xff = header(req, 'x-forwarded-for');
  const ip =
    firstForwarded(xff) ?? header(req, 'x-real-ip') ?? header(req, 'cf-connecting-ip') ?? undefined;

  const http =
    req && url
      ? {
          method: req.method,
          path: url.pathname,
          host: url.host,
          query: Object.fromEntries(url.searchParams.entries()),
          referer: header(req, 'referer'),
          userAgent: header(req, 'user-agent'),
        }
      : undefined;

  const infraHints = {
    cfRay: header(req, 'cf-ray'),
    edgeRegion:
      header(req, 'fly-region') ||
      header(req, 'x-vercel-id') ||
      header(req, 'x-vercel-ip-country') ||
      undefined,
  };

  const auth =
    ctx?.userId || ctx?.sessionId
      ? {
          userId: ctx?.userId,
          sessionId: ctx?.sessionId,
        }
      : undefined;

  const base: Record<string, unknown> = {
    ...(http ? { http } : {}),
    src: { ip, forwardedFor: xff },
    ...(ctx?.route ? { route: ctx.route } : {}),
    ...(auth ? { auth } : {}),
    ...(infraHints.cfRay ? { cfRay: infraHints.cfRay } : {}),
    ...(infraHints.edgeRegion ? { edgeRegion: infraHints.edgeRegion } : {}),
    ...(ctx?.extra ? { extra: ctx.extra } : {}),
  };

  return base;
}

function safeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  try {
    return JSON.parse(JSON.stringify(err));
  } catch {
    return { value: String(err) };
  }
}

/* ──────────────────────────── emitters ─────────────────────────── */

export async function emitAuditEvent(
  name: string,
  payload?: AuditPayload,
  ctx?: AuditCtx,
): Promise<void> {
  const meta = { ...buildMeta(ctx), ...(payload ?? {}) };
  await audit.emit(name, { meta });
}

export const auditEvent = {
  async emit(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
    return emitAuditEvent(name, payload, ctx);
  },
  async ok(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
    const meta = { ...buildMeta(ctx), ...(payload ?? {}) };
    await audit.emit(name, { outcome: 'success', meta });
  },
  async fail(name: string, reason: string, detail?: unknown, ctx?: AuditCtx) {
    const meta = { ...buildMeta(ctx), reason, ...(detail ? { error: safeError(detail) } : {}) };
    await audit.emit(name, { outcome: 'failure', severity: 'warn', meta });
  },
  async denied(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
    const meta = { ...buildMeta(ctx), ...(payload ?? {}) };
    await audit.emit(name, { outcome: 'denied', severity: 'warn', meta });
  },
  async rateLimited(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
    const meta = { ...buildMeta(ctx), reason: 'rate_limited', ...(payload ?? {}) };
    await audit.emit(name, { outcome: 'denied', severity: 'warn', meta });
  },
};

/* ─────────────────────── high-level helpers ────────────────────── */

export async function auditOk(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
  return auditEvent.ok(name, payload, ctx);
}

export async function auditFail(name: string, reason: string, detail?: unknown, ctx?: AuditCtx) {
  return auditEvent.fail(name, reason, detail, ctx);
}

export async function auditDenied(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
  return auditEvent.denied(name, payload, ctx);
}

export async function auditRateLimited(name: string, payload?: AuditPayload, ctx?: AuditCtx) {
  return auditEvent.rateLimited(name, payload, ctx);
}

/* ──────────────────────── ctx meta helper ──────────────────────── */

function pickCtxMeta<TCtx extends object>(ctx: TCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const r = ctx as unknown as Record<string, unknown>;

  const uid = r?.userId;
  if (typeof uid === 'string' && uid) out.userId = uid;

  const session = r?.session;
  if (session && typeof session === 'object') {
    const su = (session as Record<string, unknown>).user;
    if (su && typeof su === 'object') {
      const sid = (su as Record<string, unknown>).id;
      if (typeof sid === 'string' && sid) out.sessionUserId = sid;
    }
  }

  const params = r?.params;
  if (params && typeof params === 'object') out.params = params as Record<string, unknown>;

  const route = r?.route;
  if (typeof route === 'string' && route) out.route = route;

  return out;
}

/* ───────────────────────── audited wrapper ─────────────────────── */

export function audited<TCtx extends object = { params?: Record<string, string> }>(
  name: string,
  opts?: { onSuccess?: (_res: Response, _ctx: TCtx) => AuditPayload | void }, // prefix args to satisfy no-unused-vars in type context
) {
  return (handler: (req: Request, ctx: TCtx) => Promise<Response> | Response) =>
    async (req: Request, ctx: TCtx): Promise<Response> => {
      const ctxMeta = pickCtxMeta(ctx);

      try {
        const res = await handler(req, ctx);

        const extraFromHook = opts?.onSuccess?.(res, ctx);
        const successPayload: AuditPayload = {
          status: res.status,
          ...(Object.keys(ctxMeta).length ? { ctx: ctxMeta } : {}),
          ...(extraFromHook ?? {}),
        };

        await auditOk(name, successPayload, { req });
        return res;
      } catch (err) {
        const failCtx: AuditCtx =
          Object.keys(ctxMeta).length > 0 ? { req, extra: { ctx: ctxMeta } } : { req };

        await auditFail(name, 'exception', err, failCtx);
        throw err;
      }
    };
}