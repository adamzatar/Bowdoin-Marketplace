// packages/rate-limit/src/redisClient.ts
/* eslint-env node */
/**
 * Redis client singleton for rate-limit package.
 * - Optional dependency on @bowdoin/observability/logger (loaded at runtime)
 * - Uses Node's console module with a local Console instance as fallback
 */

import { Console } from "console";
import { createRequire } from "module";
import process from "process";

import { createClient, type RedisClientType } from "redis";

const require = createRequire(import.meta.url);

let _client: RedisClientType | null = null;
let _connecting: Promise<RedisClientType> | null = null;

/* Narrow, runtime-only logger shape (avoid global Console typings) */
type MinimalLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

/** Local, typed fallback logger using Node's Console class. */
const fallbackConsole: MinimalLogger = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
}) as unknown as MinimalLogger;

/**
 * Soft-optional logger from @bowdoin/observability/logger.
 * Loaded via createRequire to avoid static resolution (keeps this pkg standalone).
 */
function getLogger(): MinimalLogger {
  try {
    const mod: unknown = require("@bowdoin/observability/logger");
    const maybe = mod as { logger?: MinimalLogger } | null;
    if (maybe?.logger && typeof maybe.logger.info === "function") return maybe.logger;
  } catch {
    // module not present in this consumer — fall through
  }
  return fallbackConsole;
}

function maskUrl(u: string): string {
  // hide credentials in logs: redis://:*****@host:port
  return u.replace(/\/\/.*@/, "//***@");
}

function getRedisUrl(): string {
  const direct = process.env.REDIS_URL?.trim();
  if (direct) return direct;

  const host = process.env.REDIS_HOST?.trim() || "127.0.0.1";
  const port = process.env.REDIS_PORT?.trim() || "6379";
  const pass = process.env.REDIS_PASSWORD?.trim() || process.env.REDIS_PASS?.trim();

  if (pass) return `redis://:${encodeURIComponent(pass)}@${host}:${port}`;
  return `redis://${host}:${port}`;
}

/** Connect (idempotent + concurrency-safe). */
export async function getRedisClient(): Promise<RedisClientType> {
  if (_client && _client.isOpen) return _client;
  if (_connecting) return _connecting;

  const logger = getLogger();
  const url = getRedisUrl();

  _connecting = (async () => {
    const client: RedisClientType = createClient({
      url,
      socket: {
        // Backoff: 100ms * retries up to ~3s, then cap at 3s
        reconnectStrategy: (retries: number) => Math.min(3000, 100 * retries),
      },
    });

    client.on("error", (err: unknown) => {
      const msg =
        (err as { message?: string })?.message ??
        (typeof err === "string" ? err : JSON.stringify(err));
      logger.error?.(`[rate-limit] Redis error: ${msg}`);
    });

    try {
      await client.connect();
      logger.info?.(`[rate-limit] Redis connected (${maskUrl(url)})`);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      logger.error?.(`[rate-limit] Redis connect failed: ${msg}`);
      _connecting = null;
      throw e;
    }

    _client = client;
    _connecting = null;
    return client;
  })();

  return _connecting;
}

/** Graceful close for shutdown hooks. */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    try {
      await _client.quit();
    } catch {
      // swallow – best-effort close
    }
  }
  _client = null;
  _connecting = null;
}

/** Test helper: drop the singleton (forces a fresh connection next time). */
export function __resetRedisClientForTests(): void {
  _client = null;
  _connecting = null;
}

/** Diagnostic helper: public form of the configured URL (credentials masked). */
export function getRedisPublicUrl(): string {
  return maskUrl(getRedisUrl());
}

export type { RedisClientType } from "redis";
