// packages/security/src/rate-limits/community.ts
/**
 * @module @bowdoin/security/rate-limits/community
 *
 * Centralized rate-limit policies and helpers that differentiate Bowdoin
 * (SSO) users from Community accounts. Uses a token-bucket strategy on Redis
 * via @bowdoin/rate-limit, with an in-memory fallback for local/dev.
 */

import crypto from "node:crypto";

import { env } from "@bowdoin/config/env";

import {
  getRedisClient,
  consume as consumeTokenBucket,
  type TokenBucketConfig,
  type RedisClientType,
} from "@bowdoin/rate-limit";

/* -------------------------------------------------------------------------------------------------
 * Types & audience helpers
 * ------------------------------------------------------------------------------------------------ */

export type Audience = "bowdoin" | "community";
export type RateKind =
  | "create_listing"
  | "send_message"
  | "search"
  | "verify_email"
  | "auth_attempt"
  | "presign_upload";

export interface RatePolicy {
  /** Max tokens in bucket. */
  capacity: number;
  /** Refill amount added every `refillIntervalSec`. */
  refillAmount: number;
  /** Interval in seconds for each refill tick. */
  refillIntervalSec: number;
  /** Optional burst multiplier (applied to capacity). */
  burstMultiplier?: number;
}

type PerAudience<T> = { bowdoin: T; community: T };

const SEC = (n: number) => n;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Helper to convert a user affiliation string to an Audience label. */
export function audienceFromAffiliation(affiliation?: string | null): Audience {
  if (!affiliation) return "community";
  const a = String(affiliation).toLowerCase();
  return a.includes("bowdoin") || a.includes("student") || a.includes("staff") || a.includes("admin")
    ? "bowdoin"
    : "community";
}

/* -------------------------------------------------------------------------------------------------
 * Policies (tunable via RATE_LIMIT_MULTIPLIER)
 * ------------------------------------------------------------------------------------------------ */

const RL_MULT = Number(env.RATE_LIMIT_MULTIPLIER ?? 1);

export const POLICIES: Record<RateKind, PerAudience<RatePolicy>> = {
  create_listing: {
    bowdoin: { capacity: 10 * RL_MULT, refillAmount: 10 * RL_MULT, refillIntervalSec: SEC(60) },
    community: { capacity: 5 * RL_MULT, refillAmount: 5 * RL_MULT, refillIntervalSec: SEC(60) },
  },
  send_message: {
    bowdoin: { capacity: 60 * RL_MULT, refillAmount: 60 * RL_MULT, refillIntervalSec: SEC(60) },
    community: { capacity: 25 * RL_MULT, refillAmount: 25 * RL_MULT, refillIntervalSec: SEC(60) },
  },
  search: {
    bowdoin: { capacity: 120 * RL_MULT, refillAmount: 120 * RL_MULT, refillIntervalSec: SEC(60) },
    community: { capacity: 60 * RL_MULT, refillAmount: 60 * RL_MULT, refillIntervalSec: SEC(60) },
  },
  verify_email: {
    bowdoin: { capacity: 3 * RL_MULT, refillAmount: 3 * RL_MULT, refillIntervalSec: SEC(3600) },
    community: { capacity: 2 * RL_MULT, refillAmount: 2 * RL_MULT, refillIntervalSec: SEC(3600) },
  },
  auth_attempt: {
    bowdoin: { capacity: 20 * RL_MULT, refillAmount: 20 * RL_MULT, refillIntervalSec: SEC(600) },
    community: { capacity: 10 * RL_MULT, refillAmount: 10 * RL_MULT, refillIntervalSec: SEC(600) },
  },
  presign_upload: {
    bowdoin: { capacity: 30 * RL_MULT, refillAmount: 30 * RL_MULT, refillIntervalSec: SEC(300) },
    community: { capacity: 10 * RL_MULT, refillAmount: 10 * RL_MULT, refillIntervalSec: SEC(300) },
  },
};

/* -------------------------------------------------------------------------------------------------
 * Identity & keys
 * ------------------------------------------------------------------------------------------------ */

export interface Identity {
  /** Optional authenticated user id (UUID/ULID). */
  userId?: string | null;
  /** Best-effort client IP. */
  ip: string;
}

/** Try to derive a stable client IP from common proxy headers. */
export function ipFromHeaders(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real;
  return "0.0.0.0";
}

export function identityFromRequest(headers: Headers, userId?: string | null): Identity {
  return { userId: userId ?? null, ip: ipFromHeaders(headers) };
}

function sha24(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function bucketKey(kind: RateKind, audience: Audience, id: Identity) {
  const subject = id.userId ? `u:${sha24(id.userId)}` : `ip:${sha24(id.ip)}`;
  return `rl:${kind}:${audience}:${subject}`;
}

/* -------------------------------------------------------------------------------------------------
 * Engine selection (Redis vs. in-memory)
 * ------------------------------------------------------------------------------------------------ */

let redis: RedisClientType | null = null;
async function ensureRedis(): Promise<RedisClientType | null> {
  if ((env.RATE_LIMITS_DISABLED ?? "false") === "true") return null;
  if (redis) return redis;
  try {
    redis = await getRedisClient();
    return redis;
  } catch {
    redis = null; // fallback to in-memory
    return null;
  }
}

// In-memory token bucket for local/dev.
type MemState = {
  tokens: number;
  capacity: number;
  lastRefill: number;
  refillAmount: number;
  refillIntervalSec: number;
};
const memBuckets = new Map<string, MemState>();

export type ConsumeResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  /** epoch seconds when the bucket next refills (approx) */
  resetAt: number;
};

function consumeInMemory(
  bucket: string,
  policy: RatePolicy,
  now = nowSeconds(),
  tokens = 1,
): ConsumeResult {
  const s =
    memBuckets.get(bucket) ??
    (() => {
      const init: MemState = {
        tokens: policy.capacity,
        capacity: policy.capacity,
        lastRefill: now,
        refillAmount: policy.refillAmount,
        refillIntervalSec: policy.refillIntervalSec,
      };
      memBuckets.set(bucket, init);
      return init;
    })();

  const intervals = Math.floor((now - s.lastRefill) / s.refillIntervalSec);
  if (intervals > 0) {
    s.tokens = Math.min(s.capacity, s.tokens + intervals * s.refillAmount);
    s.lastRefill += intervals * s.refillIntervalSec;
  }

  const allowed = s.tokens >= tokens;
  if (allowed) s.tokens -= tokens;

  const remaining = Math.max(0, Math.floor(s.tokens));
  const retryAfterSec = allowed
    ? 0
    : Math.max(1, Math.ceil(((tokens - s.tokens) / s.refillAmount) * s.refillIntervalSec));

  const resetAt = s.lastRefill + s.refillIntervalSec;
  return { allowed, remaining, limit: s.capacity, retryAfterSec, resetAt };
}

/* -------------------------------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------------------------------ */

export interface EnforceParams {
  headers: Headers;
  /** Optional authenticated user id; if omitted the limiter keys by IP. */
  userId?: string | null;
  /** Tokens to consume (cost); default 1. */
  tokens?: number;
}

export class RateLimitDecision {
  constructor(
    public readonly kind: RateKind,
    public readonly audience: Audience,
    public readonly result: ConsumeResult,
  ) {}

  /** True if the request may proceed. */
  get allowed(): boolean {
    return this.result.allowed;
  }

  /** IETF RateLimit and Retry-After headers. */
  headers(): Headers {
    const h = new Headers();
    h.set("RateLimit-Limit", String(this.result.limit));
    h.set("RateLimit-Remaining", String(this.result.remaining));
    const resetDelta = Math.max(0, (this.result.resetAt || nowSeconds()) - nowSeconds());
    h.set("RateLimit-Reset", String(resetDelta));
    if (!this.result.allowed && this.result.retryAfterSec) {
      h.set("Retry-After", String(Math.max(1, Math.ceil(this.result.retryAfterSec))));
    }
    return h;
  }

  /** Merge headers into existing headers (for successful responses). */
  applyHeaders(target = new Headers()): Headers {
    const h = this.headers();
    for (const [k, v] of h) target.set(k, v);
    return target;
  }

  /** Prebuilt 429 response with appropriate headers/body. */
  to429(message = "Too Many Requests"): Response {
    const h = this.headers();
    const headers = new Headers(h);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(
      JSON.stringify({
        error: "rate_limited",
        kind: this.kind,
        audience: this.audience,
        retryAfterSec: this.result.retryAfterSec,
        message,
      }),
      { status: 429, headers },
    );
  }
}

/**
 * Enforce a rate-limit for a given kind and audience, keyed by userId when available, else IP.
 * Also applies a secondary coarse IP-global limiter to reduce anonymous abuse.
 */
export async function enforceRateLimit(
  kind: RateKind,
  audience: Audience,
  { headers, userId, tokens = 1 }: EnforceParams,
): Promise<RateLimitDecision> {
  // Global kill-switch
  if ((env.RATE_LIMITS_DISABLED ?? "false") === "true") {
    return new RateLimitDecision(kind, audience, {
      allowed: true,
      limit: Number.MAX_SAFE_INTEGER,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterSec: 0,
      resetAt: nowSeconds() + 1,
    });
  }

  const policy = POLICIES[kind][audience];
  const id = identityFromRequest(headers, userId ?? null);
  const subjectKey = bucketKey(kind, audience, id);
  const capacity =
    policy.burstMultiplier && policy.burstMultiplier > 1
      ? Math.ceil(policy.capacity * policy.burstMultiplier)
      : policy.capacity;

  const client = await ensureRedis();

  let primary: ConsumeResult;
  if (client) {
    const cfg: TokenBucketConfig = {
      key: subjectKey,
      capacity,
      refillAmount: policy.refillAmount,
      refillIntervalMs: policy.refillIntervalSec * 1000,
      namespace: "rl:sec",
      client,
    };
    const res = await consumeTokenBucket(cfg, tokens);
    primary = {
      allowed: res.allowed,
      limit: capacity,
      remaining: res.remaining,
      retryAfterSec: res.retryAfterMs ? Math.ceil(res.retryAfterMs / 1000) : 0,
      resetAt: Math.ceil(res.resetAtMs / 1000),
    };
  } else {
    primary = consumeInMemory(subjectKey, { ...policy, capacity }, nowSeconds(), tokens);
  }

  // Secondary coarse IP limiter to absorb anonymous spray (regardless of auth)
  const ipPolicy: RatePolicy = {
    capacity: 120 * RL_MULT,
    refillAmount: 120 * RL_MULT,
    refillIntervalSec: SEC(60),
  };
  const ipKey = `rl:_global_ip:${sha24(id.ip)}`;

  let ipGate: ConsumeResult;
  if (client) {
    const cfg: TokenBucketConfig = {
      key: ipKey,
      capacity: ipPolicy.capacity,
      refillAmount: ipPolicy.refillAmount,
      refillIntervalMs: ipPolicy.refillIntervalSec * 1000,
      namespace: "rl:sec",
      client,
    };
    const res = await consumeTokenBucket(cfg, 1);
    ipGate = {
      allowed: res.allowed,
      limit: ipPolicy.capacity,
      remaining: res.remaining,
      retryAfterSec: res.retryAfterMs ? Math.ceil(res.retryAfterMs / 1000) : 0,
      resetAt: Math.ceil(res.resetAtMs / 1000),
    };
  } else {
    ipGate = consumeInMemory(ipKey, ipPolicy, nowSeconds(), 1);
  }

  // Combine decisions: both must allow
  const allowed = primary.allowed && ipGate.allowed;
  const merged: ConsumeResult = {
    allowed,
    limit: primary.limit,
    remaining: Math.min(primary.remaining, ipGate.remaining),
    retryAfterSec: allowed ? 0 : Math.max(primary.retryAfterSec, ipGate.retryAfterSec),
    resetAt: Math.max(primary.resetAt, ipGate.resetAt),
  };

  return new RateLimitDecision(kind, audience, merged);
}

/* -------------------------------------------------------------------------------------------------
 * Handler wrapper
 * ------------------------------------------------------------------------------------------------ */

export type AudienceResolveObject = { audience: Audience; userId?: string | null };
export type AudienceResolver =
  | Audience
  | ((req: Request) => Audience | AudienceResolveObject | Promise<Audience | AudienceResolveObject>);

/**
 * Wrap a Next.js App Router handler with rate limiting.
 * The resolver can be a string ('bowdoin'/'community') or a function that returns
 * the audience and optionally a userId.
 */
export function withRateLimit<TCtx = unknown>(
  kind: RateKind,
  audienceOrResolver: AudienceResolver,
  handler: (req: Request, ctx: TCtx) => Promise<Response>,
  options?: { tokens?: number },
) {
  return async (req: Request, ctx: TCtx): Promise<Response> => {
    const resolved =
      typeof audienceOrResolver === "function" ? await audienceOrResolver(req) : audienceOrResolver;

    const aObj: AudienceResolveObject =
      typeof resolved === "string" ? { audience: resolved } : (resolved as AudienceResolveObject);

    const decision = await enforceRateLimit(kind, aObj.audience, {
      headers: req.headers,
      userId: aObj.userId ?? null,
      tokens: options?.tokens ?? 1,
    });

    if (!decision.allowed) return decision.to429();

    const res = await handler(req, ctx);
    const merged = new Headers(res.headers);
    for (const [k, v] of decision.headers()) merged.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
  };
}