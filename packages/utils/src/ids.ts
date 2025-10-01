/**
 * @module @bowdoin/utils/ids
 * Stable, collision-resistant identifiers for entities and events.
 * - Zero external deps (uses Node `crypto`)
 * - URL-safe base62 alphabet by default
 * - Semantic prefixes to aid debugging/tracing
 * - Centralized parsing and validation
 */

import { randomBytes, randomUUID } from "node:crypto";

/** Default alphabet: URL-safe + lowercased (base36) */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const DEFAULT_SIZE = 16;

/** Typed branded ID helper */
export type ID<T extends string> = string & { __brand: T };

/** Internal: generate `size` chars from a custom alphabet using cryptographically-strong bytes. */
function randomFromAlphabet(size: number, alphabet: string): string {
  if (size <= 0) return "";
  const bytes = randomBytes(size);
  const base = alphabet.length;
  let out = "";
  for (let i = 0; i < size; i++) {
    out += alphabet[bytes[i] % base];
  }
  return out;
}

/**
 * Generate a random ID with a semantic prefix.
 * @example
 * const userId = genId('usr'); // usr_x8kd92jl...
 */
export function genId<T extends string>(prefix: T, size = DEFAULT_SIZE): ID<T> {
  const id = randomFromAlphabet(size, ALPHABET);
  return `${prefix}_${id}` as ID<T>;
}

/**
 * Validate an ID string against a prefix and expected length.
 * Returns `true` if it looks valid.
 */
export function isValidId<T extends string>(
  id: string,
  prefix: T,
  size = DEFAULT_SIZE
): id is ID<T> {
  const re = new RegExp(`^${prefix}_[${ALPHABET}]{${size}}$`);
  return re.test(id);
}

/**
 * Parse an ID safely; throws if invalid.
 */
export function parseId<T extends string>(
  id: string,
  prefix: T,
  size = DEFAULT_SIZE
): ID<T> {
  if (!isValidId(id, prefix, size)) {
    throw new Error(`Invalid ID format for prefix "${prefix}": ${id}`);
  }
  return id as ID<T>;
}

/**
 * Short non-prefixed IDs (e.g., correlation IDs, tracing, temporary keys).
 * Defaults to base62 for compactness; length is adjustable.
 */
export function shortId(size = 8): string {
  // Use a slightly richer alphabet for short IDs (base62).
  const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return randomFromAlphabet(size, base62);
}

/**
 * Generate a time-sortable ID (ULID-like).
 * This is not a strict ULID spec implementation, but preserves time ordering:
 * base36 timestamp + random tail.
 */
export function ulidLike(): string {
  const nowBase36 = Date.now().toString(36);
  const rand = randomFromAlphabet(10, "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  return `${nowBase36}_${rand}`;
}

/**
 * RFC4122 v4 UUID (Node-native, fast path).
 */
export function uuid(): string {
  return randomUUID();
}
