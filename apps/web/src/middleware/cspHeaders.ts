// apps/web/src/middleware/cspHeaders.ts
/* global crypto, process */ // let eslint know these globals are valid in middleware

// Production-grade CSP + security headers for Next.js middleware.
// - Sets strict security headers for every response
// - Applies a strong CSP to HTML responses (Report-Only in dev)
// - Supports nonces and env-based allowlists (CDN, analytics, etc.)
// - Gracefully degrades if the shared CSP builder API changes
//
// Usage (apps/web/middleware.ts):
//   import { applyCSPAndSecurityHeaders } from "./src/middleware/cspHeaders";
//   export function middleware(req: NextRequest) {
//     const res = NextResponse.next();
//     return applyCSPAndSecurityHeaders(req, res);
//   }

import { buildContentSecurityPolicy as sharedBuildCSP } from '@bowdoin/security/csp';
import {
  createSecurityHeaders,
  securityHeaders as securityHeadersFactory,
} from '@bowdoin/security/headers';

import type { NextRequest, NextResponse } from 'next/server';

// ---- Types -----------------------------------------------------------------

type ApplyOptions = {
  /** If true, sends CSP in Report-Only mode (overrides NODE_ENV). Defaults to NODE_ENV !== "production". */
  reportOnly?: boolean;
  /** Provide a pre-generated nonce (if you want to re-use an existing one). If omitted, a nonce is generated automatically. */
  nonce?: string;
  /** Extra connect/img/script/style/font/frame ancestors sources to allow. */
  allow?: {
    connect?: string[];
    img?: string[];
    script?: string[];
    style?: string[];
    font?: string[];
    frameAncestors?: string[];
  };
};

// ---- Helpers ----------------------------------------------------------------

/** Generate a CSP nonce compatible with edge runtime (no Node Buffer). */
function genNonce(): string {
  // A UUID without dashes is sufficiently unpredictable for a CSP nonce token.
  // (CSP nonces are opaque tokens; base64 is common but not required.)
  return crypto.randomUUID().replace(/-/g, '');
}

type CSPDirectiveValue = string[] | true;
type BuildCSPOptions = {
  directives: Readonly<Record<string, CSPDirectiveValue>>;
  reportOnly?: boolean;
};

/** Serialize a CSP directives map into a header string. */
function serializeCSP(
  directives: Readonly<Record<string, CSPDirectiveValue | undefined>>,
): string {
  return Object.entries(directives)
    .filter(([, v]) => v && (Array.isArray(v) ? v.length : true))
    .map(([k, v]) => (v === true ? k : `${k} ${(v as string[]).join(' ')}`))
    .join('; ');
}

function isPolicyLike(value: unknown): value is { directives: Readonly<Record<string, CSPDirectiveValue>> } {
  return value !== null && typeof value === 'object' && 'directives' in (value as object);
}

/** Safely call the shared builder (API may evolve); fallback to local serializer. */
function buildCSP(
  directives: Readonly<Record<string, CSPDirectiveValue>>,
  opts?: { reportOnly?: boolean },
): string {
  try {
    const result: unknown = (sharedBuildCSP as unknown as (
      input: BuildCSPOptions | Readonly<Record<string, CSPDirectiveValue>>,
    ) => unknown)({ directives, reportOnly: !!opts?.reportOnly });

    if (typeof result === 'string') return result;
    if (isPolicyLike(result)) return serializeCSP(result.directives);
  } catch {
    // fall through
  }
  return serializeCSP(directives);
}

/** Detect if the response should include CSP (HTML pages). */
function wantsHTML(req: NextRequest): boolean {
  const accept = req.headers.get('accept') || '';
  return /text\/html/.test(accept);
}

/** Collect allowlist from env (comma-separated) and inline extras. */
function envList(name: string): string[] {
  const v = process.env[name]?.trim();
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- Main -------------------------------------------------------------------

export function applyCSPAndSecurityHeaders(
  req: NextRequest,
  res: NextResponse,
  opts?: ApplyOptions,
) {
  const isProd = process.env.NODE_ENV === 'production';
  const reportOnly = opts?.reportOnly ?? !isProd;

  // ---------- Base Security Headers ----------
  const baseHeaders = (typeof securityHeadersFactory === 'function'
    ? securityHeadersFactory
    : createSecurityHeaders)();
  for (const [k, v] of Object.entries(baseHeaders)) {
    res.headers.set(k, v);
  }

  // ---------- CSP (only for HTML) ----------
  if (wantsHTML(req)) {
    const nonce = opts?.nonce ?? genNonce();

    // Allowlists from env (comma-separated host patterns; include schemes if needed):
    const cdnHost = envList('NEXT_PUBLIC_CDN_HOST');
    const imgHosts = envList('NEXT_PUBLIC_IMG_HOSTS');
    const analyticsHosts = envList('NEXT_PUBLIC_ANALYTICS_HOSTS');
    const apiOrigin = envList('NEXT_PUBLIC_API_ORIGIN');
    const extraConnect = opts?.allow?.connect ?? [];
    const extraImg = opts?.allow?.img ?? [];
    const extraScript = opts?.allow?.script ?? [];
    const extraStyle = opts?.allow?.style ?? [];
    const extraFont = opts?.allow?.font ?? [];
    const extraFrameAncestors = opts?.allow?.frameAncestors ?? [];

    const scriptNonce = `'nonce-${nonce}'`;
    const styleNonce = `'nonce-${nonce}'`;

    // In development, Next requires eval for React Refresh & sourcemaps.
    const devScriptRelaxations = isProd ? [] : [`'unsafe-eval'`];

    const connectSrc = [
      `'self'`,
      'https:',
      ...apiOrigin,
      ...cdnHost,
      ...analyticsHosts,
      ...extraConnect,
      ...(isProd ? [] : ['ws:', 'wss:']),
    ];

    const imgSrc = [`'self'`, 'data:', 'blob:', 'https:', ...cdnHost, ...imgHosts, ...extraImg];

    const scriptSrc = [
      `'self'`,
      scriptNonce,
      "'strict-dynamic'",
      ...analyticsHosts,
      ...extraScript,
      ...devScriptRelaxations,
    ];

    const styleSrc = [
      `'self'`,
      styleNonce,
      ...(isProd ? [] : [`'unsafe-inline'`]),
      ...extraStyle,
    ];

    const fontSrc = [`'self'`, 'data:', 'https:', ...cdnHost, ...extraFont];

    // Modern clickjacking protection via CSP:
    const frameAncestors = [`'none'`, ...extraFrameAncestors];

    // Useful additions:
    const objectSrc = [`'none'`];
    const baseUri = [`'self'`];
    const formAction = [`'self'`];

    // Reporting (optional):
    const reportToGroup = 'csp-endpoint';
    const reportUri = process.env.NEXT_PUBLIC_CSP_REPORT_URI || '/api/csp-report';

    // Upgrade HTTP subresources to HTTPS in prod:
    const upgradeInsecureRequests = isProd;

    // Final directives map:
    const directives: Record<string, CSPDirectiveValue> = {
      'default-src': [`'self'`],
      'base-uri': baseUri,
      'frame-ancestors': frameAncestors,
      'object-src': objectSrc,
      'form-action': formAction,
      'img-src': imgSrc,
      'script-src': scriptSrc,
      'style-src': styleSrc,
      'font-src': fontSrc,
      'connect-src': connectSrc,
      ...(upgradeInsecureRequests ? { 'upgrade-insecure-requests': true } : {}),
      ...(reportUri ? { 'report-uri': [reportUri] } : {}),
      ...(reportUri ? { 'report-to': [reportToGroup] } : {}),
    };

    const headerName = reportOnly
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';

    const csp = buildCSP(directives, { reportOnly });
    res.headers.set(headerName, csp);

    // Expose nonce via HttpOnly cookie for server components to read.
    const cookieParts = [
      `csp-nonce=${nonce}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      isProd ? 'Secure' : '',
      'Max-Age=120',
    ].filter(Boolean);
    res.headers.append('Set-Cookie', cookieParts.join('; '));
  }

  return res;
}
