// apps/web/src/middleware/cspHeaders.ts
//
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
import { securityHeaders } from '@bowdoin/security/headers';

import type { NextResponse, NextRequest } from 'next/server';

// ---- Types -----------------------------------------------------------------

type ApplyOptions = {
  /**
   * If true, sends CSP in Report-Only mode (overrides NODE_ENV).
   * Defaults to NODE_ENV !== "production".
   */
  reportOnly?: boolean;
  /**
   * Provide a pre-generated nonce (if you want to re-use an existing one).
   * If omitted, a nonce is generated automatically.
   */
  nonce?: string;
  /**
   * Extra connect/img/script/style/font/frame ancestors sources to allow.
   * Useful for feature flags without changing core policy.
   */
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

/** Serialize a CSP directives map into a header string. */
function serializeCSP(directives: Record<string, string[] | true | undefined>): string {
  return Object.entries(directives)
    .filter(([, v]) => v && (Array.isArray(v) ? v.length : true))
    .map(([k, v]) => {
      if (v === true) return k;
      return `${k} ${(v as string[]).join(' ')}`;
    })
    .join('; ');
}

/** Safely call the shared builder (API may evolve); fallback to local serializer. */
function buildCSP(
  directives: Record<string, string[] | true>,
  opts?: { reportOnly?: boolean },
): string {
  try {
    // Most likely API: sharedBuildCSP({ directives, reportOnly })
    // or older convenience API: sharedBuildCSP({...flat directives...})
    // We try the directives-shape first; if it throws, fallback.
    // @ts-expect-error – tolerate differing APIs at runtime.
    const str = sharedBuildCSP({ directives, reportOnly: !!opts?.reportOnly });
    if (typeof str === 'string' && str.includes(';')) return str;
  } catch {
    // ignore and fallback
  }
  return serializeCSP(directives);
}

/** Detect if the response should include CSP (HTML pages). */
function wantsHTML(req: NextRequest): boolean {
  const accept = req.headers.get('accept') || '';
  // Handle navigations and regular HTML fetches (GET/HEAD with text/html)
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
  // These come from the shared security package (@bowdoin/security).
  // It should include sensible defaults: Referrer-Policy, X-Frame-Options (or frame-ancestors CSP),
  // X-Content-Type-Options, Permissions-Policy, Cross-Origin-Opener-Policy, etc.
  const baseHeaders = securityHeaders();
  for (const [k, v] of Object.entries(baseHeaders)) {
    res.headers.set(k, v);
  }

  // ---------- CSP (only for HTML) ----------
  if (wantsHTML(req)) {
    const nonce = opts?.nonce ?? genNonce();

    // Allowlists from env (comma-separated host patterns; include schemes if needed):
    // Examples:
    //   NEXT_PUBLIC_CDN_HOST="https://cdn.example.com"
    //   NEXT_PUBLIC_IMG_HOSTS="https://images.example.com, https://assets.example.org"
    //   NEXT_PUBLIC_ANALYTICS_HOSTS="https://plausible.example.com"
    //   NEXT_PUBLIC_API_ORIGIN="https://api.example.com"
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
      // Allow hot-reload in dev
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
      // Many component libs require inline styles; we prefer nonce,
      // but keep unsafe-inline in dev to reduce friction.
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
    const reportUri = process.env.NEXT_PUBLIC_CSP_REPORT_URI || '/api/csp-report'; // implement endpoint later

    // Upgrade HTTP subresources to HTTPS in prod:
    const upgradeInsecureRequests = isProd;

    // Final directives map:
    const directives: Record<string, string[] | true> = {
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
      // Optional extras:
      ...(upgradeInsecureRequests ? { 'upgrade-insecure-requests': true } : {}),
      // You can enable reporting if you wire up the endpoint:
      ...(reportUri ? { 'report-uri': [reportUri] } : {}),
      // Many UAs support report-to but it's fine if omitted:
      ...(reportUri ? { 'report-to': [reportToGroup] } : {}),
    };

    const headerName = reportOnly
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';

    const csp = buildCSP(directives, { reportOnly });
    res.headers.set(headerName, csp);

    // Expose nonce to the app via an HTTP-only, same-site cookie, so
    // server components/layouts can read it and assign to inline scripts/styles.
    // Note: The client JS cannot read HttpOnly cookies (good).
    // You can fetch it on the server with cookies().get("csp-nonce").
    const cookieParts = [
      `csp-nonce=${nonce}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      isProd ? 'Secure' : '',
      // Short TTL; rotate per request
      'Max-Age=120',
    ].filter(Boolean);
    res.headers.append('Set-Cookie', cookieParts.join('; '));
  }

  return res;
}
