// apps/web/src/server/rateLimit.ts
//
// Thin, production-grade rate-limiting utilities for App Router handlers.
// Uses the shared Redis token bucket (@bowdoin/rate-limit) and returns
// consistent headers + JSON errors with Retry-After.
//
// Typical usage:
//
//   import { enforceRateLimit } from "./rateLimit";
//
//   export async function POST(req: Request) {
//     await enforceRateLimit(req, { name: "auth:email-verify", limit: 5, windowSec: 60 });
//     // ...do work...
//     return Response.json({ ok: true });
//   }
//
// Or wrap a handler:
//
//   export const POST = withRateLimit({ name: "messages:send", limit: 20, windowSec: 60 })(async (req) => {
//     // handler...
//   });
//

import {
  getRedisClient, // public root export
  consume, // functional API (no class)
  type TokenBucketConfig, // config type
} from '@bowdoin/rate-limit';

/* ───────────────────────────── Types & defaults ───────────────────────────── */

export type RateLimitOptions = {
  /** Logical limiter name; included in headers/keys (e.g., "listings:create"). */
  name: string;
  /** Max tokens per window. */
  limit: number;
  /** Window in seconds (token refill period). */
  windowSec: number;
  /**
   * Optional override for the identifier key. If not provided we derive one
   * from the authenticated user id header (x-user-id) or client IP.
   */
  key?: string;
  /**
   * If true, only annotate headers and never block; useful in shadow mode to
   * evaluate limiter behavior in prod safely.
   */
  shadowMode?: boolean;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
  limit: number;
  bucketKey: string;
};

/* ───────────────────────────── Public API ─────────────────────────────────── */

/**
 * Enforce a token bucket rate limit for a request. Throws a Response (429)
 * when the limit is exceeded unless `shadowMode` is enabled.
 */
export async function enforceRateLimit(
  req: Request,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const res = await evaluateRateLimit(req, opts);

  if (!res.allowed && !opts.shadowMode) {
    throw tooManyResponse(res, opts.name);
  }

  return res;
}

/**
 * Create a handler wrapper that enforces rate limit and sets informative headers.
 * Example:
 *   export const POST = withRateLimit({ name:"upload:presign", limit:30, windowSec:60 })(async (req) => {...})
 */
export function withRateLimit(opts: RateLimitOptions) {
  return function <H extends (req: Request, ctx?: unknown) => Promise<Response> | Response>(
    handler: H,
  ) {
    return async function (req: Request, ctx?: unknown): Promise<Response> {
      const res = await evaluateRateLimit(req, opts);

      let response: Response;
      if (!res.allowed && !opts.shadowMode) {
        response = tooManyResponse(res, opts.name);
      } else {
        response = await handler(req, ctx);
      }

      return attachRateHeaders(response, res, opts.name, !!opts.shadowMode);
    };
  };
}

/**
 * Evaluate (but don't throw) a rate limit for a request.
 * Useful for custom branching or multi-key strategies.
 */
export async function evaluateRateLimit(
  req: Request,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  // Ensure Redis client is available (the consume() call will use it implicitly if the
  // rate-limit package shares a client; calling here keeps connection lifecycle predictable)
  await getRedisClient();

  const base = sanitizeName(opts.name);
  const id = opts.key ?? deriveIdentity(req);

  // We want the effective storage key to look like: rl:<name>:<id>
  // The functional API composes storageKey = `${namespace}:${key}`
  const cfg: TokenBucketConfig = {
    key: id,
    namespace: `rl:${base}`,
    capacity: opts.limit,
    refillAmount: opts.limit, // “classic window” refill: restore full limit each window
    refillIntervalMs: opts.windowSec * 1000, // window length
  };

  const out = await consume(cfg, 1);
  const now = Date.now();
  const resetSeconds = Math.max(0, Math.ceil((out.resetAtMs - now) / 1000));

  return {
    allowed: out.allowed,
    remaining: out.remaining,
    resetSeconds,
    limit: opts.limit,
    bucketKey: out.storageKey,
  };
}

/* ───────────────────────────── Helpers ────────────────────────────────────── */

/**
 * Try to derive a stable identity per requester, preferring user id if your
 * auth middleware injects it, otherwise client IP via common headers.
 */
function deriveIdentity(req: Request): string {
  // Prefer explicit user id if upstream added it (e.g., in middleware)
  const userId =
    req.headers.get('x-user-id') ||
    req.headers.get('x-userid') ||
    req.headers.get('x-auth-user') ||
    '';

  if (userId) return `u:${userId}`;

  // Best-effort IP from common proxy/CDN headers
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    // Node's request doesn't expose socket here; fall back to UA hash
    hashish(req.headers.get('user-agent') || 'unknown');

  return `ip:${ip}`;
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9:_-]/g, '-');
}

function hashish(input: string): string {
  // Tiny non-crypto hash for fallback identity
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/** JSON 429 with problem details and Retry-After. */
function tooManyResponse(r: RateLimitResult, name: string): Response {
  const body = {
    error: 'rate_limited',
    limiter: name,
    remaining: r.remaining,
    resetSeconds: r.resetSeconds,
  };
  const resp = new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(r.resetSeconds || 1),
    },
  });
  return attachRateHeaders(resp, r, name, false);
}

/** Attach standard X-RateLimit headers (compatible with GitHub-style semantics). */
function attachRateHeaders(
  response: Response,
  r: RateLimitResult,
  name: string,
  shadow: boolean,
): Response {
  const headers = new Headers(response.headers);
  headers.set('x-ratelimit-limit', String(r.limit));
  headers.set('x-ratelimit-remaining', String(Math.max(0, r.remaining)));
  headers.set('x-ratelimit-reset', String(r.resetSeconds));
  headers.set('x-ratelimit-policy', `${name}; window=${r.resetSeconds}s; limit=${r.limit}`);
  headers.set('x-ratelimit-shadow-mode', shadow ? '1' : '0');
  headers.set('x-ratelimit-bucket', r.bucketKey);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/* ───────────────────────────── Convenience presets ──────────────────────────
   You can tune these, or import presets from @bowdoin/security if you prefer.
----------------------------------------------------------------------------- */

/** Conservative default for user actions: 60 reqs / 60s. */
export function defaultLimiter(name: string, key?: string): RateLimitOptions {
  return { name, limit: 60, windowSec: 60, ...(key ? { key } : {}) };
}

/** Stricter bursty action (e.g., login/verify): 5 reqs / 60s. */
export function sensitiveActionLimiter(name: string, key?: string): RateLimitOptions {
  return { name, limit: 5, windowSec: 60, ...(key ? { key } : {}) };
}

/**
 * Simple direct limiter utility for call sites that were doing:
 *   await rateLimit("some-key", 30, 60)
 */
export async function rateLimit(
  bucketKey: string,
  limit: number,
  windowSec: number,
): Promise<void> {
  const cfg: TokenBucketConfig = {
    key: bucketKey,
    namespace: 'rl:direct',
    capacity: limit,
    refillAmount: limit,
    refillIntervalMs: windowSec * 1000,
  };
  const res = await consume(cfg, 1);
  if (!res.allowed) {
    const retrySec = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
    const message = 'rate_limited';
    const err = new RateLimitError(message, 429, retrySec);
    throw err;
  }
}

/* ───────────────────────────── Error type ─────────────────────────────────── */

class RateLimitError extends Error {
  readonly status: number;
  readonly retryAfter: number;
  constructor(message: string, status: number, retryAfter: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
