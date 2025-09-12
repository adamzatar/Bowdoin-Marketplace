/**
 * @module @bowdoin/utils/ids
 * Stable, collision-resistant identifiers for entities and events.
 * - Uses nanoid for URL-safe unique IDs
 * - Provides semantic prefixes to aid debugging/tracing
 * - Centralizes parsing and validation
 */

import { customAlphabet, nanoid } from 'nanoid';

/** Default alphabet: URL-safe + lowercased */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const DEFAULT_SIZE = 16;

/** Typed branded ID helper */
export type ID<T extends string> = string & { __brand: T };

/**
 * Generate a random ID with a semantic prefix.
 * @example
 * const userId = genId('usr'); // usr_x8kd92jl...
 */
export function genId<T extends string>(
  prefix: T,
  size = DEFAULT_SIZE,
): ID<T> {
  const id = customAlphabet(ALPHABET, size)();
  return `${prefix}_${id}` as ID<T>;
}

/**
 * Validate an ID string against a prefix and expected length.
 * Returns `true` if it looks valid.
 */
export function isValidId<T extends string>(
  id: string,
  prefix: T,
  size = DEFAULT_SIZE,
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
  size = DEFAULT_SIZE,
): ID<T> {
  if (!isValidId(id, prefix, size)) {
    throw new Error(`Invalid ID format for prefix "${prefix}": ${id}`);
  }
  return id as ID<T>;
}

/**
 * Short non-prefixed IDs (e.g., for correlation IDs, tracing, temporary keys).
 */
export function shortId(size = 8): string {
  return nanoid(size);
}

/**
 * Generate a time-sortable ULID-style ID.
 * (Not cryptographically secure; useful for logs or ordering.)
 */
export function ulidLike(): string {
  const now = Date.now().toString(36);
  const rand = nanoid(10);
  return `${now}_${rand}`;
}