// packages/auth/src/utils/email-token-store.ts
/**
 * Email verification token store with Redis backend and an in-memory fallback.
 * - Stores only a SHA-256 hash of the token (never the raw token).
 * - Keys are namespaced per user+email.
 * - Designed to work under exactOptionalPropertyTypes.
 */

import { randomBytes, createHash } from "node:crypto";
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from "node:timers";

import { getRedisClient } from "@bowdoin/rate-limit/redisClient";

import type { RedisClientType } from "redis";

/* ───────────────────────────── Types ───────────────────────────── */

type ISO8601 = string;

export interface EmailTokenRecord {
  userId: string;
  email: string;
  /** sha256 of the raw token */
  tokenHash: string;
  /** expiry in unix seconds */
  expiresAt: number;
  createdAt: ISO8601;
  /** set only when consumed; omitted otherwise */
  consumedAt?: ISO8601;
}

export interface EmailTokenCreateOpts {
  userId: string;
  email: string;
  /** default 15 minutes; min 60s */
  ttlSeconds?: number;
}

export interface EmailTokenVerifyOpts {
  userId: string;
  email: string;
  /** raw token from the verification link */
  token: string;
}

/* ───────────────────────────── Internals ───────────────────────── */

const nowSec = () => Math.floor(Date.now() / 1000);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const keyOf = (userId: string, email: string) =>
  `auth:email-token:${userId}:${email.toLowerCase().trim()}`;

/* ───────────────────────────── Store ───────────────────────────── */

export class EmailTokenStore {
  private client: RedisClientType | null;
  private mem = new Map<string, EmailTokenRecord>();
  private memTimers = new Map<string, ReturnType<typeof nodeSetTimeout>>();

  constructor(client?: RedisClientType | null) {
    this.client = client ?? null;
  }

  /** Convenience factory using the shared Redis client. */
  static async create(): Promise<EmailTokenStore> {
    let client: RedisClientType | null = null;
    try {
      client = await getRedisClient();
    } catch {
      client = null; // fallback to memory
    }
    return new EmailTokenStore(client);
  }

  /** Ensure a Redis client; swallow errors and use memory in dev/test. */
  private async ensure(): Promise<RedisClientType | null> {
    if (this.client) return this.client;
    try {
      this.client = await getRedisClient();
    } catch {
      this.client = null;
    }
    return this.client;
  }

  /**
   * Create a verification token and return the **raw** token (for emailing).
   * Only the hash is stored server-side.
   */
  async create(
    opts: EmailTokenCreateOpts
  ): Promise<{ token: string; expiresAt: number }> {
    const ttl = Math.max(60, opts.ttlSeconds ?? 15 * 60);
    const token = newToken();
    const tokenHash = sha256(token);
    const expiresAt = nowSec() + ttl;

    const rec: EmailTokenRecord = {
      userId: opts.userId,
      email: opts.email,
      tokenHash,
      expiresAt,
      createdAt: new Date().toISOString(),
      // consumedAt intentionally omitted until used
    };

    const key = keyOf(opts.userId, opts.email);
    const client = await this.ensure();

    if (client) {
      // Store JSON and set TTL (NX avoids overwriting an existing non-expired record)
      await client.set(key, JSON.stringify(rec), { EX: ttl, NX: true });
    } else {
      const existingTimer = this.memTimers.get(key);
      if (existingTimer) {
        nodeClearTimeout(existingTimer);
        this.memTimers.delete(key);
      }
      this.mem.set(key, rec);
      // naive GC (dev-only): remove after TTL
      const t = nodeSetTimeout(() => {
        this.mem.delete(key);
        this.memTimers.delete(key);
      }, ttl * 1000);
      // Node-only: avoid keeping the event loop alive when supported
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        t.unref();
      }
      this.memTimers.set(key, t);
    }

    return { token, expiresAt };
  }

  /**
   * Verify a token and consume it if valid.
   * Returns true when it matches and has not expired; false otherwise.
   * Idempotent on success (deletes record).
   */
  async verifyAndConsume(opts: EmailTokenVerifyOpts): Promise<boolean> {
    const key = keyOf(opts.userId, opts.email);
    const tokenHash = sha256(opts.token);
    const client = await this.ensure();

    let rec: EmailTokenRecord | null = null;

    if (client) {
      const raw = await client.get(key);
      rec = raw ? (JSON.parse(raw) as EmailTokenRecord) : null;
    } else {
      rec = this.mem.get(key) ?? null;
    }

    if (!rec) return false;
    if (rec.tokenHash !== tokenHash) return false;

    // Expired → clean up and reject
    if (rec.expiresAt < nowSec()) {
      if (client) await client.del(key);
      else {
        this.mem.delete(key);
        const timer = this.memTimers.get(key);
        if (timer) {
          nodeClearTimeout(timer);
          this.memTimers.delete(key);
        }
      }
      return false;
    }

    // Success → consume
    if (client) {
      await client.del(key);
    } else {
      this.mem.delete(key);
      const timer = this.memTimers.get(key);
      if (timer) {
        nodeClearTimeout(timer);
        this.memTimers.delete(key);
      }
    }

    return true;
  }

  /** Optional helpers */
  async delete(userId: string, email: string): Promise<void> {
    const key = keyOf(userId, email);
    const client = await this.ensure();
    if (client) await client.del(key);
    else {
      this.mem.delete(key);
      const timer = this.memTimers.get(key);
      if (timer) {
        nodeClearTimeout(timer);
        this.memTimers.delete(key);
      }
    }
  }

  async peek(userId: string, email: string): Promise<EmailTokenRecord | null> {
    const key = keyOf(userId, email);
    const client = await this.ensure();
    if (client) {
      const raw = await client.get(key);
      return raw ? (JSON.parse(raw) as EmailTokenRecord) : null;
    }
    return this.mem.get(key) ?? null;
  }
}
