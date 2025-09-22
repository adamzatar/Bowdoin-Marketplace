// packages/rate-limit/src/index.ts
/**
 * @module @bowdoin/rate-limit
 * Public entry for the rate-limit package.
 *
 * Exposes:
 *  - getRedisClient (and optional close helper)
 *  - Functional token bucket API: consume / getState / perSecondConfig / toHttpHeaders
 *  - Back-compat TokenBucket shim (object with same function references)
 */

import {
  consume,
  getState,
  perSecondConfig,
  toHttpHeaders,
  type TokenBucketConfig,
  type ConsumeResult,
} from "./tokenBucket";

import type { RedisClientType } from "redis";

// Re-export public surface so both root (.) and subpaths resolve consistently.
export { getRedisClient } from "./redisClient";
export type { RedisClientType };
export { consume, getState, perSecondConfig, toHttpHeaders };
export type { TokenBucketConfig, ConsumeResult };

/**
 * Attempt to gracefully close a cached Redis client if one was memoized
 * on globalThis by the redisClient module. This function does **not**
 * import the client to preserve tree-shaking and avoid hard runtime deps.
 */
export async function closeRedisClient(): Promise<void> {
  try {
    // Support a couple of possible global cache keys.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const client: RedisClientType | null =
      g?.__BOWDOIN_REDIS__ ?? g?.__BOWDOIN_REDIS_CLIENT__ ?? null;

    if (client?.isOpen) {
      await client.quit();
    }
  } catch {
    // optional helper: swallow errors
  }
}

/**
 * Back-compat object shim for older imports that expect a TokenBucket object.
 * Example:
 *   import { TokenBucket } from '@bowdoin/rate-limit';
 *   await TokenBucket.consume(cfg, 1);
 */
export const TokenBucket = {
  consume,
  getState,
  perSecondConfig,
  toHttpHeaders,
} as const;
