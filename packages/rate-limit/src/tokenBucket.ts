/**
 * @module @bowdoin/rate-limit/tokenBucket
 *
 * High-precision, atomic token bucket using Redis + Lua.
 * - Stores state per key in a Redis hash: { tokens, ts }.
 * - Configurable capacity (burst), refill amount, and interval.
 * - All math is done server-side in Lua for race-free updates.
 */

import { getRedisClient } from "./redisClient";

import type { RedisClientType } from "redis";

/* ------------------------------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------------------------------ */

export type TokenBucketConfig = {
  /** Unique identity to rate-limit (e.g., `ip:1.2.3.4` or `user:uuid`). */
  key: string;
  /** Max tokens the bucket can hold (burst capacity). */
  capacity: number;
  /** Number of tokens added every `refillIntervalMs` (e.g., 5/1000ms = 5 tps). */
  refillAmount: number;
  /** Refill interval in milliseconds. */
  refillIntervalMs: number;
  /** Optional namespace prefix to keep keys organized. Default: "rl:tb". */
  namespace?: string;
  /**
   * TTL in seconds to set on the bucket key to allow natural GC of inactive buckets.
   * Default: 2 * ceil(refillIntervalMs/1000) or 60 (whichever is larger).
   */
  ttlSeconds?: number;
  /** Provide a custom clock in ms (useful for testing). Defaults to Date.now(). */
  nowMs?: number;
  /** Inject an existing Redis client (mainly for tests). Defaults to shared client. */
  client?: RedisClientType;
};

export type ConsumeResult = {
  /** Whether the requested tokens were granted. */
  allowed: boolean;
  /** Remaining tokens after the operation (integer here). */
  remaining: number;
  /** When the bucket will be fully reset to capacity (epoch ms). */
  resetAtMs: number;
  /** If not allowed, hint for Retry-After in ms (0 if allowed). */
  retryAfterMs: number;
  /** The Redis storage key used. */
  storageKey: string;
};

/* ------------------------------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------------------------------ */

function defaultTTL(refillIntervalMs: number): number {
  const twoIntervals = Math.ceil(refillIntervalMs / 1000) * 2;
  return Math.max(60, twoIntervals);
}

function storageKey(ns: string, key: string) {
  return `${ns}:${key}`;
}

/**
 * Lua script (atomic):
 * KEYS[1]   -> bucket key
 * ARGV[1]   -> capacity (number)
 * ARGV[2]   -> refillAmount (number)
 * ARGV[3]   -> refillIntervalMs (number)
 * ARGV[4]   -> requestedTokens (number)
 * ARGV[5]   -> nowMs (number)
 * ARGV[6]   -> ttlSeconds (number)
 *
 * Returns:
 *  { allowed, remaining, resetAtMs, retryAfterMs, newTokens, newTs }
 */
const LUA = `
local key              = KEYS[1]
local capacity         = tonumber(ARGV[1])
local refillAmount     = tonumber(ARGV[2])
local refillIntervalMs = tonumber(ARGV[3])
local requested        = tonumber(ARGV[4])
local nowMs            = tonumber(ARGV[5])
local ttlSeconds       = tonumber(ARGV[6])

local h        = redis.call('HMGET', key, 'tokens', 'ts')
local tokens   = tonumber(h[1])
local ts       = tonumber(h[2])

if tokens == nil then
  tokens = capacity
  ts = nowMs
end

local elapsed = nowMs - ts
if elapsed >= refillIntervalMs then
  local refills = math.floor(elapsed / refillIntervalMs)
  tokens = math.min(capacity, tokens + (refills * refillAmount))
  ts = ts + (refills * refillIntervalMs)
end

local allowed = 0
local remaining = tokens

if tokens >= requested then
  allowed = 1
  remaining = tokens - requested
  tokens = remaining
else
  allowed = 0
end

-- Next full reset time to capacity
local deficit = capacity - tokens
local intervalsToFull = 0
if refillAmount > 0 then
  intervalsToFull = math.ceil(deficit / refillAmount)
end
local resetAtMs = ts + (intervalsToFull * refillIntervalMs)

-- Retry-After if not allowed: how long until enough tokens are available
local retryAfterMs = 0
if allowed == 0 then
  local missing = requested - tokens
  local intervalsToEnough = 0
  if refillAmount > 0 then
    intervalsToEnough = math.ceil(missing / refillAmount)
  end
  retryAfterMs = math.max(0, (ts + (intervalsToEnough * refillIntervalMs)) - nowMs)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
if ttlSeconds > 0 then
  redis.call('EXPIRE', key, ttlSeconds)
end

return { allowed, remaining, resetAtMs, retryAfterMs, tokens, ts }
`;

let cachedSha: string | null = null;

async function ensureScript(client: RedisClientType): Promise<string> {
  if (cachedSha) return cachedSha;
  const sha = await client.sendCommand<string[]>(["SCRIPT", "LOAD", LUA]);
  // redis v4 returns a string; some codecs may wrap
  cachedSha = Array.isArray(sha) ? (sha[0] as unknown as string) : (sha as unknown as string);
  return cachedSha!;
}

/** Coerce/validate Redis EVALSHA response into a 6-number tuple. */
function normalizeEvalResult(raw: unknown): [number, number, number, number, number, number] {
  const arr =
    ((raw as Array<number | string> | undefined)?.map((v) =>
      typeof v === "string" ? Number(v) : v
    ) as Array<number | undefined>) ?? [];

  if (arr.length < 6 || arr.some((v) => typeof v !== "number" || Number.isNaN(v))) {
    throw new Error(`[rate-limit] bad redis response: ${JSON.stringify(raw)}`);
  }
  // Force tuple typing
  return [arr[0]!, arr[1]!, arr[2]!, arr[3]!, arr[4]!, arr[5]!] as const;
}

/* ------------------------------------------------------------------------------------------------
 * Public API (functional)
 * ------------------------------------------------------------------------------------------------ */

/**
 * Consume `requestedTokens` from the bucket if available.
 * Returns the resulting state and hints for retry.
 */
export async function consume(cfg: TokenBucketConfig, requestedTokens = 1): Promise<ConsumeResult> {
  const client = cfg.client ?? (await getRedisClient());
  const ns = cfg.namespace ?? "rl:tb";
  const key = storageKey(ns, cfg.key);
  const nowMs = cfg.nowMs ?? Date.now();
  const ttl = cfg.ttlSeconds ?? defaultTTL(cfg.refillIntervalMs);

  const sha = await ensureScript(client);

  let rawOut: unknown;
  try {
    rawOut = await client.evalSha(sha, {
      keys: [key],
      arguments: [
        String(cfg.capacity),
        String(cfg.refillAmount),
        String(cfg.refillIntervalMs),
        String(requestedTokens),
        String(nowMs),
        String(ttl),
      ],
    } as any); // redis typings are overly narrow for evalSha
  } catch (e) {
    // Fallback: if script missing (e.g., after Redis restart), reload and retry once
    if ((e as Error)?.message?.toLowerCase().includes("noscript")) {
      cachedSha = null;
      const sha2 = await ensureScript(client);
      rawOut = await client.evalSha(sha2, {
        keys: [key],
        arguments: [
          String(cfg.capacity),
          String(cfg.refillAmount),
          String(cfg.refillIntervalMs),
          String(requestedTokens),
          String(nowMs),
          String(ttl),
        ],
      } as any);
    } else {
      throw e;
    }
  }

  const [allowedNum, remaining, resetAtMs, retryAfterMs] = normalizeEvalResult(rawOut);

  return {
    allowed: allowedNum === 1,
    remaining,
    resetAtMs,
    retryAfterMs,
    storageKey: key,
  };
}

/**
 * Peek current bucket state without consuming tokens.
 * Uses a zero-consume so math stays identical to `consume`.
 */
export function getState(cfg: TokenBucketConfig): Promise<ConsumeResult> {
  return consume(cfg, 0);
}

/**
 * Helper to build a standard config for N tokens per second with a burst.
 * Example: perSecondConfig('ip:1.2.3.4', { perSecond: 5, burst: 20 })
 */
export function perSecondConfig(
  key: string,
  opts: {
    perSecond: number;
    burst?: number;
    namespace?: string;
    ttlSeconds?: number;
    client?: RedisClientType;
  }
): TokenBucketConfig {
  const { perSecond, burst = perSecond, namespace, ttlSeconds, client } = opts;

  // Build without writing optional properties as `undefined`
  const base: TokenBucketConfig = {
    key,
    capacity: burst,
    refillAmount: perSecond,
    refillIntervalMs: 1000,
  };
  if (namespace) base.namespace = namespace;
  if (typeof ttlSeconds === "number") base.ttlSeconds = ttlSeconds;
  if (client) base.client = client;

  return base;
}

/**
 * Map to HTTP headers for well-known rate-limit semantics (IETF RateLimit + Retry-After).
 * Useful in API route handlers.
 */
export function toHttpHeaders(result: ConsumeResult): Record<string, string> {
  const now = Date.now();
  const resetSec = Math.max(0, Math.ceil((result.resetAtMs - now) / 1000));
  const retrySec = Math.ceil(result.retryAfterMs / 1000);

  return {
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSec),
    ...(retrySec > 0 ? { "Retry-After": String(retrySec) } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Back-compat class (preferred API is functional)
 * ------------------------------------------------------------------------------------------------ */

export class TokenBucket {
  #cfg: TokenBucketConfig;
  constructor(config: TokenBucketConfig) {
    this.#cfg = config;
  }
  consume(cost = 1): Promise<ConsumeResult> {
    return consume(this.#cfg, cost);
  }
  getState(): Promise<ConsumeResult> {
    return getState(this.#cfg);
  }

  /** Convenience to build a per-second bucket (static helper). */
  static perSecondConfig = perSecondConfig;
  /** Convenience to map results to headers (static helper). */
  static toHttpHeaders = toHttpHeaders;
}