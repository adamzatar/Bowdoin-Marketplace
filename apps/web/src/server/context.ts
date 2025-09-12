// apps/web/src/server/context.ts
//
// Per-request server context for Route Handlers (App Router).
// Centralizes session lookup, db handle, request metadata, logging,
// and tracing so your handlers can stay tiny and consistent.

import { authOptions } from '@bowdoin/auth/nextauth';
import { env } from '@bowdoin/config/env';
import { flags } from '@bowdoin/config/flags';
import { prisma } from '@bowdoin/db';
import { logger as baseLogger } from '@bowdoin/observability/logger';
import { metrics } from '@bowdoin/observability/metrics';
import { tracer } from '@bowdoin/observability/tracing';
import { getServerSession } from 'next-auth';

import type { NextRequest } from 'next/server';

export type Session = Awaited<ReturnType<typeof getServerSession>> | null;

type RequestLike = NextRequest | Request;

export interface ServerContext {
  /** Raw request (NextRequest or Fetch Request). */
  req: RequestLike;
  /** Parsed URL (fast access to pathname/query). */
  url: URL;
  /** HTTP method. */
  method: string;
  /** Best-effort client IP extracted from headers. */
  ip: string | null;
  /** User agent string if present. */
  userAgent: string | null;
  /** Stable ID for this request; attached to logs/metrics. */
  requestId: string;

  /** Auth session (NextAuth) or null if anonymous. */
  session: Session;

  /** Prisma client (shared singleton from @bowdoin/db). */
  db: typeof prisma;

  /** Structured logger pre-bound with request fields. */
  logger: typeof baseLogger;

  /** Metrics facade (counter/timer helpers). */
  metrics: typeof metrics;

  /** Tracing facade (OpenTelemetry). */
  tracing: typeof tracer;

  /** Runtime config and feature flags snapshot. */
  config: {
    env: typeof env;
    flags: typeof flags;
  };

  /** Utility: respond with common headers (x-request-id). */
  withCommonHeaders(res: Response): Response;
}

/**
 * Build the server context for a given request.
 * Call this at the start of every route handler (or use `withContext`).
 */
export async function createContext(req: RequestLike): Promise<ServerContext> {
  const url = toURL(req);
  const method = (req as Request).method ?? 'GET';
  const requestId = getRequestId(req);
  const ip = getClientIp(req);
  const userAgent = getHeader(req, 'user-agent');

  // Auth session (works in App Router without passing req/res)
  const session = await getServerSession(authOptions);

  // Logger bound to this request
  const logger = baseLogger.child({
    requestId,
    ip,
    method,
    path: url.pathname,
    ua: userAgent ?? undefined,
  });

  // Optional: start a tracing span for this request
  tracer.startActiveSpan(`route ${method} ${url.pathname}`, (span) => {
    span.setAttribute('request.id', requestId);
    span.setAttribute('http.method', method);
    span.setAttribute('http.target', url.pathname + url.search);
    if (ip) span.setAttribute('client.ip', ip);
    span.end(); // we just create a lightweight parent span; child spans can attach later
  });

  // Metric: count inbound requests by route+method
  metrics.count('http.requests.in', 1, {
    method,
    route: url.pathname,
  });

  const ctx: ServerContext = {
    req,
    url,
    method,
    ip,
    userAgent,
    requestId,
    session,
    db: prisma,
    logger,
    metrics,
    tracing: tracer,
    config: { env, flags },
    withCommonHeaders(res: Response) {
      const headers = new Headers(res.headers);
      headers.set('x-request-id', requestId);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    },
  };

  return ctx;
}

/**
 * Tiny helper to wrap a route handler function with a context.
 * Usage:
 *   export const GET = withContext(async (ctx) => {
 *     ctx.logger.info("hello");
 *     return ctx.withCommonHeaders(Response.json({ ok: true }));
 *   });
 */
export function withContext<H extends (ctx: ServerContext) => Promise<Response> | Response>(
  handler: H,
) {
  return async (req: NextRequest) => {
    const ctx = await createContext(req);
    try {
      const res = await handler(ctx);
      // attach request id for better observability
      return ctx.withCommonHeaders(res);
    } catch (err) {
      ctx.logger.error({ err }, 'unhandled route error');
      metrics.count('http.requests.error', 1, { route: ctx.url.pathname });
      return ctx.withCommonHeaders(
        new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
  };
}

/* ----------------------------- utils ----------------------------------- */

function toURL(req: RequestLike): URL {
  // NextRequest has .url already; generic Request does too.
  // Create a URL instance so we can read pathname/searchParams easily.
  // @ts-expect-error `url` is present on both NextRequest and Request
  return new URL(req.url);
}

function getHeader(req: RequestLike, name: string): string | null {
  // @ts-expect-error both NextRequest and Request expose Headers via .headers
  const h: Headers | undefined = req.headers;
  return h?.get?.(name) ?? null;
}

function getClientIp(req: RequestLike): string | null {
  // Try common proxy headers first (in order)
  const xff = getHeader(req, 'x-forwarded-for');
  if (xff) {
    // XFF can be a comma-separated list: client, proxy1, proxy2
    const ip = xff.split(',')[0]?.trim();
    if (ip) return ip;
  }
  const real = getHeader(req, 'x-real-ip');
  if (real) return real;
  // Cloudflare
  const cf = getHeader(req, 'cf-connecting-ip');
  if (cf) return cf;
  // Fall back to null (Next doesn't expose remoteAddress in edge)
  return null;
}

function getRequestId(req: RequestLike): string {
  const fromHeader =
    getHeader(req, 'x-request-id') ?? getHeader(req, 'cf-ray') ?? getHeader(req, 'fly-request-id');
  return fromHeader ?? safeUUID();
}

function safeUUID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    // @ts-ignore - randomUUID exists in Node 16.17+ / modern runtimes
    return crypto.randomUUID();
  }
  // Fallback (very rare paths, tests)
  return `req_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
