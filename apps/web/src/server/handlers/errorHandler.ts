// apps/web/src/server/handlers/errorHandler.ts
/**
 * Minimal JSON response helpers for API handlers.
 * - `json(data, init?)` for success payloads
 * - `jsonError(status, code, extra?, init?)` for standardized errors
 * - Convenience in `errors.*` (badRequest, unauthorized, forbidden, notFound, tooMany, serverError)
 */

export type JsonInit = ResponseInit & { headers?: HeadersInit };

/** Build a JSON response with proper headers. */
export function json<T>(data: T, init: JsonInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

/**
 * Standard JSON error payload: `{ error: code, ...extra }`
 * Example:
 *   return jsonError(401, "unauthorized", { reason: "missing_token" });
 */
export function jsonError(
  status: number,
  code: string,
  extra?: Record<string, unknown>,
  init?: Omit<JsonInit, 'status'>,
): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify({ error: code, ...(extra ?? {}) }), {
    ...init,
    status,
    headers,
  });
}

/** Common shortcuts. */
export const errors = {
  badRequest: (
    code = 'bad_request',
    extra?: Record<string, unknown>,
    init?: Omit<JsonInit, 'status'>,
  ) => jsonError(400, code, extra, init),

  unauthorized: (
    code = 'unauthorized',
    extra?: Record<string, unknown>,
    init?: Omit<JsonInit, 'status'>,
  ) => jsonError(401, code, extra, init),

  forbidden: (
    code = 'forbidden',
    extra?: Record<string, unknown>,
    init?: Omit<JsonInit, 'status'>,
  ) => jsonError(403, code, extra, init),

  notFound: (
    code = 'not_found',
    extra?: Record<string, unknown>,
    init?: Omit<JsonInit, 'status'>,
  ) => jsonError(404, code, extra, init),

  tooMany: (retryAfterSec?: number, code = 'rate_limited', extra?: Record<string, unknown>) => {
    const headers: HeadersInit = {};
    if (retryAfterSec && retryAfterSec > 0) headers['retry-after'] = String(retryAfterSec);
    return jsonError(429, code, extra, { headers });
  },

  serverError: (
    code = 'internal_error',
    extra?: Record<string, unknown>,
    init?: Omit<JsonInit, 'status'>,
  ) => jsonError(500, code, extra, init),
} as const;

/*
  Import order tip for callers (to satisfy lint rules):

  // 1) external libs / workspace packages
  import { prisma } from "@bowdoin/db";
  import { z } from "zod";

  // 2) absolute app aliases
  import { withAuth } from "../withAuth";
  import { rateLimit } from "../rateLimit";
  import { jsonError } from "./errorHandler";
  import { auditEvent } from "./audit";

  // 3) relative imports
*/
