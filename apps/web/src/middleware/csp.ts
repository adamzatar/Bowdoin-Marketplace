// apps/web/src/middleware/csp.ts
//
// Small helpers to work with the CSP that middleware sets.
// - Re-exports the shared CSP builder
// - Utilities to read the nonce set by middleware (from cookies)
// - JSX helper props for inline <script> / <style> tags
// - Tiny helpers to merge allowlists ergonomically

import { cookies as nextCookies } from 'next/headers';

import type { NextRequest } from 'next/server';

// Re-export the shared CSP builder from the security package
export { buildContentSecurityPolicy } from '@bowdoin/security/csp';

/** Cookie name used by the middleware to expose the per-request CSP nonce. */
export const CSP_NONCE_COOKIE = 'csp-nonce';
/** Header names for convenience. */
export const CSP_HEADER = 'Content-Security-Policy';
export const CSP_RO_HEADER = 'Content-Security-Policy-Report-Only';

/** Minimal shape we need to read cookies from a request-like object. */
type RequestLike = Pick<Request, 'headers'> | Pick<NextRequest, 'headers'>;

/** Parse a single cookie value by name from a Cookie header string. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  // Basic, fast parse (no decode; nonce is opaque)
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1);
  }
  return null;
}

/**
 * Get CSP nonce from a Request/NextRequest-like object (server/edge runtime).
 * Returns null if absent.
 */
export function getNonceFromRequest(req: RequestLike): string | null {
  // Some runtimes (Next edge) provide Headers; treat it uniformly.
  // headers.get is case-insensitive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headers = (req as any).headers as Headers;
  const cookieHeader = headers?.get?.('cookie') ?? null;
  return readCookie(cookieHeader, CSP_NONCE_COOKIE);
}

/**
 * Get CSP nonce using Next's `cookies()` (Route Handlers/Server Components).
 * Safely falls back to reading from global request headers when not available.
 */
export function getServerNonce(): string | null {
  try {
    // Next 13+ server runtime
    const c = nextCookies();
    const v = c.get(CSP_NONCE_COOKIE)?.value ?? null;
    if (v) return v;
  } catch {
    // Not in a Next server context (e.g., plain node script)
  }
  // Last resort: attempt to read from process.env (debug/tests) or return null
  return process.env.__TEST_CSP_NONCE__ ?? null;
}

/** Helper to emit props for inline <script> tags: `<script {...cspScriptProps()} />` */
export function cspScriptProps(nonce?: string): { nonce?: string } {
  const n = nonce ?? getServerNonce() ?? undefined;
  return n ? { nonce: n } : {};
}

/** Helper to emit props for inline <style> tags: `<style {...cspStyleProps()} />` */
export function cspStyleProps(nonce?: string): { nonce?: string } {
  const n = nonce ?? getServerNonce() ?? undefined;
  return n ? { nonce: n } : {};
}

/**
 * Merge multiple allowlists into a unique, ordered array.
 * Useful when building CSP allowlists in config.
 */
export function mergeAllowlists(
  ...lists: Array<ReadonlyArray<string> | undefined | null>
): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      const v = item.trim();
      if (v) seen.add(v);
    }
  }
  return Array.from(seen);
}

/**
 * Convenience for building a directives object by merging defaults with overrides.
 * Skips falsy/empty arrays.
 */
export function buildDirectives(
  base: Record<string, ReadonlyArray<string> | true | undefined>,
  override: Record<string, ReadonlyArray<string> | true | undefined>,
): Record<string, string[] | true> {
  const out: Record<string, string[] | true> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const k of keys) {
    const a = base[k];
    const b = override[k];
    if (a === true || b === true) {
      out[k] = true;
      continue;
    }
    const merged = mergeAllowlists(
      Array.isArray(a) ? a : undefined,
      Array.isArray(b) ? b : undefined,
    );
    if (merged.length) out[k] = merged;
  }
  return out;
}
