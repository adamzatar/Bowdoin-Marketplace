// packages/security/src/csrf.ts
/**
 * @module @bowdoin/security/csrf
 *
 * Double-submit cookie CSRF protection, suitable for Next.js (App Router) route handlers
 * and middleware. Exposes helpers to mint a CSRF token + cookie and to assert it on
 * mutating requests. Uses secure cookie flags and constant-time comparison.
 *
 * Strategy:
 * - On any GET/HEAD that renders a form or initializes a session, call `mintCsrfCookie()`
 *   and send the Set-Cookie. Embed the token value in the page (hidden input) or send it to
 *   the client app; for XHRs, clients should echo it via `X-CSRF-Token` header.
 * - For state-changing methods (POST/PUT/PATCH/DELETE), call `assertCsrf(...)`. It verifies
 *   the header/body token equals the cookie token using timing-safe compare.
 *
 * Notes:
 * - Cookie name defaults to "__Host-csrf" (host-only cookie: requires Secure + Path=/ + no Domain).
 * - Cookie is intentionally NOT HttpOnly so the client can read and echo it (double-submit pattern).
 * - SameSite=Strict (or Lax) significantly reduces CSRF risk even before the token check.
 * - You may choose to only enforce CSRF if an auth/session cookie is present, see `shouldEnforce()`.
 */

import crypto from 'node:crypto';

import { env } from '@bowdoin/config';

import type { IncomingHttpHeaders } from 'node:http';

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
type EnforceableMethod = Exclude<Method, 'GET' | 'HEAD' | 'OPTIONS'>;

export interface CsrfOptions {
  /** Cookie name; defaults to "__Host-csrf" (recommended). */
  cookieName?: string;
  /** Token length in bytes before base64url; defaults to 32. */
  bytes?: number;
  /** Cookie TTL in seconds; defaults to 2 hours. */
  maxAgeSeconds?: number;
  /** SameSite mode; "Strict" (default) or "Lax". */
  sameSite?: 'Strict' | 'Lax';
  /** Whether to set `Secure` on the cookie; defaults to true in production. */
  secure?: boolean;
  /** Path for the cookie; default "/". */
  path?: string;
  /**
   * If provided, override cookie domain. NOTE: using a Domain disables "__Host-" constraints.
   * Prefer leaving undefined to get a host-only cookie.
   */
  domain?: string;
}

export interface CsrfExtraction {
  /** CSRF token from header or body/form. */
  presentedToken?: string;
  /** CSRF token from cookie. */
  cookieToken?: string;
}

export class CsrfError extends Error {
  status = 403;
  code = 'CSRF_VERIFICATION_FAILED' as const;
  constructor(message = 'Forbidden: CSRF token invalid or missing') {
    super(message);
    this.name = 'CsrfError';
  }
}

/* ---------------------------------- utils ---------------------------------- */

const B64URL = {
  enc(buf: Buffer): string {
    return buf
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  },
  dec(str: string): Buffer {
    const pad = 4 - (str.length % 4 || 4);
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    return Buffer.from(base64, 'base64');
  }
};

const timingSafeEq = (a?: string, b?: string) => {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

const parseCookies = (cookieHeader?: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  return out;
};

const serializeCookie = (
  name: string,
  value: string,
  {
    maxAgeSeconds = 2 * 60 * 60,
    sameSite = 'Strict',
    secure = env.NODE_ENV === 'production',
    path = '/',
    domain
  }: Required<Pick<CsrfOptions, 'maxAgeSeconds' | 'sameSite' | 'secure' | 'path'>> &
    Pick<CsrfOptions, 'domain'>
) => {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAgeSeconds}`, `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  // Not HttpOnly: double-submit requires client read access
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
};

/* ------------------------------- core exports ------------------------------- */

/**
 * Mint a fresh CSRF token and return a Set-Cookie header value.
 */
export function mintCsrfCookie(opts: CsrfOptions = {}) {
  const {
    cookieName = '__Host-csrf',
    bytes = 32,
    maxAgeSeconds = 2 * 60 * 60,
    sameSite = 'Strict',
    secure = env.NODE_ENV === 'production',
    path = '/',
    domain
  } = opts;

  // Token: random, base64url
  const token = B64URL.enc(crypto.randomBytes(bytes));
  const setCookie = serializeCookie(cookieName, token, {
    maxAgeSeconds,
    sameSite,
    secure,
    path,
    // For "__Host-" cookies, MUST NOT set Domain (host-only). Only set when explicitly provided.
    ...(domain ? { domain } : {})
  });

  return { token, setCookie, cookieName };
}

/**
 * Extract CSRF token from headers/body and cookie.
 * Recognized header names: x-csrf-token, x-xsrf-token, csrf-token.
 * Recognized body fields (JSON/form): csrfToken, _csrf.
 */
export function extractCsrf(
  headers: IncomingHttpHeaders | Headers,
  bodyToken?: unknown,
  opts: { cookieName?: string } = {}
): CsrfExtraction {
  const cookieName = opts.cookieName ?? '__Host-csrf';

  // Normalize headers access for Node or Web Fetch
  const get = (name: string) =>
    headers instanceof Headers ? headers.get(name) ?? undefined : (headers[name.toLowerCase()] as string | undefined);

  const cookieHeader =
    headers instanceof Headers ? headers.get('cookie') ?? undefined : (headers['cookie'] as string | undefined);

  const presentedToken =
    (get('x-csrf-token') ||
      get('x-xsrf-token') ||
      get('csrf-token') ||
      (typeof bodyToken === 'string' ? bodyToken : // manual pass from JSON handler
        typeof bodyToken === 'object' && bodyToken !== null
          ? // form or JSON objects: look for common keys
            // @ts-expect-error index signature
            (bodyToken['csrfToken'] || bodyToken['_csrf'])
          : undefined)) ?? undefined;

  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[cookieName];

  return { presentedToken, cookieToken };
}

/**
 * Should we enforce CSRF on this request?
 * Heuristic: enforce on mutating methods when a session cookie is present (or always).
 */
export function shouldEnforce(
  method: string,
  headers: IncomingHttpHeaders | Headers,
  {
    sessionCookieNames = ['next-auth.session-token', '__Secure-next-auth.session-token']
  }: { sessionCookieNames?: string[] } = {}
): boolean {
  const m = method.toUpperCase() as Method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;

  const cookieHeader =
    headers instanceof Headers ? headers.get('cookie') ?? '' : ((headers['cookie'] as string | undefined) ?? '');

  // If you prefer always enforcing on mutating methods, return true here.
  if (!cookieHeader) return false;

  const hasSession = sessionCookieNames.some((n) => cookieHeader.includes(`${n}=`));
  return hasSession;
}

/**
 * Assert CSRF for a request. Throws CsrfError on failure.
 *
 * @param method HTTP method (e.g., req.method)
 * @param headers raw headers (Node IncomingHttpHeaders or Web Headers)
 * @param bodyToken optional token extracted by your JSON/form parser
 * @param options cookie name override
 */
export function assertCsrf(
  method: string,
  headers: IncomingHttpHeaders | Headers,
  bodyToken?: unknown,
  options?: { cookieName?: string; onlyIfEnforceable?: boolean }
): void {
  const { cookieName, onlyIfEnforceable = true } = options ?? {};

  if (onlyIfEnforceable && !shouldEnforce(method, headers)) {
    return;
  }

  const { presentedToken, cookieToken } = extractCsrf(headers, bodyToken, { cookieName });
  if (!presentedToken || !cookieToken || !timingSafeEq(presentedToken, cookieToken)) {
    throw new CsrfError();
  }
}

/* -------------------------- Next.js integration bits ------------------------ */

/**
 * Helper to attach a fresh CSRF Set-Cookie on a response.
 * Usage (Route Handler):
 *   const { setCookie, token } = mintCsrfCookie();
 *   return new Response(html, { headers: new Headers([['Set-Cookie', setCookie]]) });
 */
export function setCookieHeader(headers: Headers, setCookieValue: string) {
  // Support multiple Set-Cookie headers
  const existing = headers.get('Set-Cookie');
  if (!existing) {
    headers.set('Set-Cookie', setCookieValue);
  } else {
    headers.append('Set-Cookie', setCookieValue);
  }
}

/**
 * Middleware guard factory for Next.js (App Router).
 * Use from apps/web/middleware.ts to auto-enforce CSRF on mutating requests.
 *
 * Example:
 *   import { NextResponse } from 'next/server';
 *   import { csrfMiddlewareGuard } from '@bowdoin/security/csrf';
 *
 *   export function middleware(req: NextRequest) {
 *     const res = NextResponse.next();
 *     const guard = csrfMiddlewareGuard();
 *     const ok = guard(req.method, req.headers);
 *     if (!ok) return new NextResponse('Forbidden', { status: 403 });
 *     return res;
 *   }
 */
export function csrfMiddlewareGuard(
  { cookieName, onlyIfEnforceable = true }: { cookieName?: string; onlyIfEnforceable?: boolean } = {}
) {
  return (method: string, headers: Headers): boolean => {
    try {
      assertCsrf(method, headers, undefined, { cookieName, onlyIfEnforceable });
      return true;
    } catch {
      return false;
    }
  };
}

/* -------------------------------- developer UX ------------------------------ */

/**
 * For SSR forms: build a hidden input with the CSRF token.
 * (Token must be rendered server-side where you also minted the cookie.)
 */
export function renderHiddenInput(token: string, name = 'csrfToken'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<input type="hidden" name="${esc(name)}" value="${esc(token)}" />`;
}

/**
 * For CSR apps: typical pattern is reading the cookie token on the client and sending
 * it as a header. Example client helper:
 *
 *   export function getCsrfHeader(): [string, string] | null {
 *     const token = document.cookie.split('; ').find(c => c.startsWith('__Host-csrf='))?.split('=')[1];
 *     return token ? ['X-CSRF-Token', decodeURIComponent(token)] : null;
 *   }
 */

/* ----------------------------------- tests ---------------------------------- */

export const __internal = { B64URL, parseCookies, serializeCookie, timingSafeEq };