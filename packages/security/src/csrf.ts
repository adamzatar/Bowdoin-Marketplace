// packages/security/src/csrf.ts
/**
 * @module @bowdoin/security/csrf
 *
 * Double-submit cookie CSRF utilities for route handlers & middleware.
 * Self-contained: no compile-time dependency on other workspace packages.
 */

import crypto from 'node:crypto';

import type { IncomingHttpHeaders } from 'node:http';

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/* ---------------------------------- config --------------------------------- */

function isProd(): boolean {
  if (typeof process !== 'undefined' && typeof process.env?.NODE_ENV === 'string') {
    return process.env.NODE_ENV === 'production';
  }

  const maybeProcess = (globalThis as { process?: { env?: { NODE_ENV?: unknown } } }).process;
  const env = maybeProcess?.env?.NODE_ENV;
  return (typeof env === 'string' ? env : undefined) === 'production';
}

export interface CsrfOptions {
  cookieName?: string;
  bytes?: number;
  maxAgeSeconds?: number;
  sameSite?: 'Strict' | 'Lax';
  secure?: boolean;
  path?: string;
  domain?: string;
}

export interface CsrfExtraction {
  presentedToken?: string;
  cookieToken?: string;
}

export class CsrfError extends Error {
  status = 403 as const;
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
    const pad = 4 - ((str.length % 4) || 4);
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    return Buffer.from(base64, 'base64');
  },
} as const;

const timingSafeEq = (a?: string, b?: string): boolean => {
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
    secure = isProd(),
    path = '/',
    domain,
  }: Required<Pick<CsrfOptions, 'maxAgeSeconds' | 'sameSite' | 'secure' | 'path'>> &
    Pick<CsrfOptions, 'domain'>,
): string => {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
};

/* ------------------------------- core exports ------------------------------- */

export function mintCsrfCookie(opts: CsrfOptions = {}) {
  const {
    cookieName = '__Host-csrf',
    bytes = 32,
    maxAgeSeconds = 2 * 60 * 60,
    sameSite = 'Strict',
    secure = isProd(),
    path = '/',
    domain,
  } = opts;

  const token = B64URL.enc(crypto.randomBytes(bytes));
  const setCookie = serializeCookie(cookieName, token, {
    maxAgeSeconds,
    sameSite,
    secure,
    path,
    ...(domain ? { domain } : {}),
  });

  return { token, setCookie, cookieName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickBodyToken(bodyToken: unknown): string | undefined {
  if (typeof bodyToken === 'string') return bodyToken;
  if (!isRecord(bodyToken)) return undefined;

  const direct = bodyToken['csrfToken'];
  if (typeof direct === 'string') return direct;

  const legacy = bodyToken['_csrf'];
  return typeof legacy === 'string' ? legacy : undefined;
}

export function extractCsrf(
  headers: IncomingHttpHeaders | Headers,
  bodyToken?: unknown,
  opts: { cookieName?: string } = {},
): CsrfExtraction {
  const cookieName = opts.cookieName ?? '__Host-csrf';

  const get = (name: string): string | undefined =>
    headers instanceof Headers
      ? headers.get(name) ?? undefined
      : (() => {
          const headerValue = headers[name.toLowerCase() as keyof IncomingHttpHeaders];
          return Array.isArray(headerValue) ? headerValue[0] : (headerValue as string | undefined);
        })();

  const cookieHeader =
    headers instanceof Headers ? headers.get('cookie') ?? undefined : (headers['cookie'] as string | undefined);

  const bodyPresentedToken = pickBodyToken(bodyToken);

  const presentedToken =
    get('x-csrf-token') ?? get('x-xsrf-token') ?? get('csrf-token') ?? bodyPresentedToken ?? undefined;

  const cookies = parseCookies(cookieHeader);
  const cookieToken: string | undefined = cookies[cookieName];

  const out: CsrfExtraction = {};
  if (presentedToken !== undefined) out.presentedToken = presentedToken;
  if (cookieToken !== undefined) out.cookieToken = cookieToken;
  return out;
}

export function shouldEnforce(
  method: string,
  headers: IncomingHttpHeaders | Headers,
  {
    sessionCookieNames = ['next-auth.session-token', '__Secure-next-auth.session-token'],
  }: { sessionCookieNames?: string[] } = {},
): boolean {
  const m = method.toUpperCase() as Method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;

  const cookieHeader =
    headers instanceof Headers ? headers.get('cookie') ?? '' : ((headers['cookie'] as string | undefined) ?? '');
  if (!cookieHeader) return false;

  const hasSession = sessionCookieNames.some((n) => cookieHeader.includes(`${n}=`));
  return hasSession;
}

export function assertCsrf(
  method: string,
  headers: IncomingHttpHeaders | Headers,
  bodyToken?: unknown,
  options?: { cookieName?: string; onlyIfEnforceable?: boolean },
): void {
  const { cookieName, onlyIfEnforceable = true } = options ?? {};
  if (onlyIfEnforceable && !shouldEnforce(method, headers)) return;

  const extractOpts: { cookieName?: string } = {};
  if (cookieName) extractOpts.cookieName = cookieName;

  const { presentedToken, cookieToken } = extractCsrf(headers, bodyToken, extractOpts);
  if (!presentedToken || !cookieToken || !timingSafeEq(presentedToken, cookieToken)) {
    throw new CsrfError();
  }
}

export function setCookieHeader(headers: Headers, setCookieValue: string) {
  const existing = headers.get('Set-Cookie');
  if (!existing) headers.set('Set-Cookie', setCookieValue);
  else headers.append('Set-Cookie', setCookieValue);
}

export function csrfMiddlewareGuard(
  { cookieName, onlyIfEnforceable = true }: { cookieName?: string; onlyIfEnforceable?: boolean } = {},
) {
  return (method: string, headers: Headers): boolean => {
    try {
      const opts: { cookieName?: string; onlyIfEnforceable?: boolean } = { onlyIfEnforceable };
      if (cookieName !== undefined) opts.cookieName = cookieName;

      assertCsrf(method, headers, undefined, opts);
      return true;
    } catch {
      return false;
    }
  };
}

export function renderHiddenInput(token: string, name = 'csrfToken'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<input type="hidden" name="${esc(name)}" value="${esc(token)}" />`;
}

export const __internal = { B64URL, parseCookies, serializeCookie, timingSafeEq };
