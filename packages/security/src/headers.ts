/**
 * @module @bowdoin/security/headers
 * Hardened HTTP security headers (policy builders + utilities).
 *
 * Usage (Next.js middleware):
 *   import { createSecurityHeaders } from '@bowdoin/security/headers';
 *   const headers = createSecurityHeaders();
 *   return NextResponse.next({ headers });
 *
 * Usage (Route Handler):
 *   const res = new Response(json, { headers: createSecurityHeaders() });
 *
 * Usage (Next config headers):
 *   export const headers = async () => nextSecurityHeaders();
 */

import type { Headers as NodeFetchHeaders } from 'undici';

type EnvSource = Record<string, string | undefined>;

const runtimeEnv: EnvSource =
  (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};

const stringFromEnv = (key: string, fallback = ''): string => runtimeEnv[key] ?? fallback;

type MutableHeaders = {
  set(key: string, value: string): void;
  has?(key: string): boolean;
};

const isHeadersMutable = (value: unknown): value is MutableHeaders =>
  typeof value === 'object' && value !== null && typeof (value as MutableHeaders).set === 'function';

/** Structured options for header generation. */
export interface SecurityHeaderOptions {
  /**
   * Fully-qualified origin of the site (no trailing slash), e.g. "https://marketplace.bowdoin.edu".
   * Used by HSTS preload and reporting endpoints. Defaults to env.APP_URL if set.
   */
  origin?: string;

  /** Enable Strict-Transport-Security (HSTS). Enabled by default in production. */
  hsts?: boolean;

  /**
   * HSTS maxAge seconds. Default: 6 months (15552000). Set to 31536000 (1 year) before preloading.
   * See: https://hstspreload.org
   */
  hstsMaxAge?: number;

  /** Add "includeSubDomains" to HSTS (recommended for apex domains you control). Default: true. */
  hstsIncludeSubDomains?: boolean;

  /** Add "preload" to HSTS (only after verifying via hstspreload.org). Default: false. */
  hstsPreload?: boolean;

  /**
   * Cross-Origin policies. We default to safe settings that do not break Next.js/3P content.
   * Set `coep: 'require-corp'` and `coop: 'same-origin'` only if you know your app is COEP/COOP clean.
   */
  coop?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none';
  coep?: 'require-corp' | 'unsafe-none';
  corp?: 'same-origin' | 'same-site' | 'cross-origin';

  /**
   * Permissions-Policy map. Keys are features, values are allowlists.
   * See: https://developer.mozilla.org/docs/Web/HTTP/Headers/Permissions-Policy
   */
  permissionsPolicy?: Partial<Record<string, string>>;

  /**
   * Referrer-Policy. Default: "strict-origin-when-cross-origin".
   * Safer than "no-referrer-when-downgrade" and preserves enough analytics.
   */
  referrerPolicy?: string;

  /**
   * Reporting endpoints (Reporting-Endpoints / Report-To).
   * Example: { default: "https://report.example.com/reports" }
   */
  reportingEndpoints?: Record<string, string>;

  /**
   * Enable legacy Report-To header (some UAs still parse it). Default: false.
   * Use only if you operate a compatible endpoint.
   */
  enableReportTo?: boolean;

  /**
   * Whether to append X-Powered-By and similar framework headers removal (where possible).
   * Default true — we set "x-powered-by" to "none".
   */
  maskPoweredBy?: boolean;
}

/** Reasonable defaults for Bowdoin Marketplace. */
const DEFAULTS: Required<
  Omit<SecurityHeaderOptions, 'origin' | 'permissionsPolicy' | 'reportingEndpoints'>
> = {
  hsts: stringFromEnv('NODE_ENV', 'development') === 'production',
  hstsMaxAge: 15552000,
  hstsIncludeSubDomains: true,
  hstsPreload: false,
  coop: 'same-origin-allow-popups',
  coep: 'unsafe-none',
  corp: 'same-origin',
  referrerPolicy: 'strict-origin-when-cross-origin',
  enableReportTo: false,
  maskPoweredBy: true,
};

/** Build the Permissions-Policy header value from a key → allowlist map. */
function buildPermissionsPolicy(map: NonNullable<SecurityHeaderOptions['permissionsPolicy']>): string {
  // Example input: { geolocation: '()', camera: '()' }  -> "geolocation=(), camera=()"
  // Valid value examples: "()","self","*","https://a.com","(self \"https://a.com\")"
  const entries = Object.entries(map).flatMap(([k, v]) => {
    const trimmed = String(v ?? '').trim();
    if (!trimmed) return [];
    return `${k}=${trimmed}`;
  });
  return entries.join(', ');
}

/** Build Reporting-Endpoints header value. */
function buildReportingEndpoints(map: Record<string, string>): string {
  // { default: "https://r.example.com/reports", csp: "https://r.example.com/csp" }
  // -> 'default="https://r.example.com/reports", csp="https://r.example.com/csp"'
  return Object.entries(map)
    .map(([name, url]) => `${name}="${url}"`)
    .join(', ');
}

/** Create a hardened header record. CSP is handled in @bowdoin/security/csp. */
export function createSecurityHeaders(opts: SecurityHeaderOptions = {}): Record<string, string> {
  const {
    origin = stringFromEnv('APP_URL', ''),
    hsts = DEFAULTS.hsts,
    hstsMaxAge = DEFAULTS.hstsMaxAge,
    hstsIncludeSubDomains = DEFAULTS.hstsIncludeSubDomains,
    hstsPreload = DEFAULTS.hstsPreload,
    coop = DEFAULTS.coop,
    coep = DEFAULTS.coep,
    corp = DEFAULTS.corp,
    permissionsPolicy,
    referrerPolicy = DEFAULTS.referrerPolicy,
    reportingEndpoints,
    enableReportTo = DEFAULTS.enableReportTo,
    maskPoweredBy = DEFAULTS.maskPoweredBy
  } = opts;

  const headers: Record<string, string> = Object.create(null);

  // --- HTTPS only (HSTS) ---
  if (hsts) {
    const tokens = [`max-age=${Math.max(0, Math.floor(hstsMaxAge))}`];
    if (hstsIncludeSubDomains) tokens.push('includeSubDomains');
    if (hstsPreload) tokens.push('preload'); // ensure you’ve validated at hstspreload.org before enabling
    headers['Strict-Transport-Security'] = tokens.join('; ');
  }

  // --- MIME sniffing protection ---
  headers['X-Content-Type-Options'] = 'nosniff';

  // --- Frame / clickjacking protection (Next.js already sets frame-ancestors via CSP; keep DENY as defense-in-depth) ---
  headers['X-Frame-Options'] = 'DENY';

  // --- Cross-origin isolation (do NOT force COEP unless audited) ---
  headers['Cross-Origin-Opener-Policy'] = coop;
  headers['Cross-Origin-Resource-Policy'] = corp;
  if (coep !== 'unsafe-none') {
    headers['Cross-Origin-Embedder-Policy'] = coep;
  }

  // --- Referrer policy ---
  headers['Referrer-Policy'] = referrerPolicy;

  // --- Permissions Policy (formerly Feature-Policy) ---
  if (permissionsPolicy && Object.keys(permissionsPolicy).length > 0) {
    headers['Permissions-Policy'] = buildPermissionsPolicy(permissionsPolicy);
  } else {
    // Sensible privacy defaults
    headers['Permissions-Policy'] = [
      'geolocation=()',
      'camera=()',
      'microphone=()',
      'payment=()',
      'usb=()',
      'accelerometer=()',
      'ambient-light-sensor=()',
      'autoplay=()',
      'battery=()',
      'display-capture=()',
      'document-domain=()',
      'encrypted-media=()',
      'fullscreen=(self)',
      'gamepad=()',
      'gyroscope=()',
      'magnetometer=()',
      'midi=()',
      'picture-in-picture=(self)',
      'publickey-credentials-get=(self)',
      'screen-wake-lock=()',
      'sync-xhr=(self)',
      'xr-spatial-tracking=()'
    ].join(', ');
  }

  // --- Reporting endpoints (optional, useful with CSP/reporting) ---
  if (reportingEndpoints && Object.keys(reportingEndpoints).length > 0) {
    headers['Reporting-Endpoints'] = buildReportingEndpoints(reportingEndpoints);
    if (enableReportTo) {
      // Legacy "Report-To" (JSON) – some UAs still rely on it
      // When multiple endpoints supplied, pick "default" as the group.
      const def = reportingEndpoints['default'];
      if (def) {
        headers['Report-To'] = JSON.stringify({
          group: 'default',
          max_age: 10886400, // 18 weeks
          endpoints: [{ url: def }],
          include_subdomains: true
        });
      }
    }
  }

  // --- Reduce header leakage ---
  if (maskPoweredBy) {
    // Next.js exposes x-powered-by by default when not disabled; set a neutral value at edge.
    headers['X-Powered-By'] = 'none';
    // Also strip some common framework headers if present in upstream (best-effort; consumers can call `stripServerHeaders`)
  }

  // --- Legacy XSS filter (harmful in modern browsers) ---
  headers['X-XSS-Protection'] = '0';

  // --- Origin-Agent-Cluster: isolate same-origin to a single process where supported (helps Spectre mitigations) ---
  headers['Origin-Agent-Cluster'] = '?1';

  // --- Cache control: security-sensitive responses can override; here we keep neutral. ---
  // (Leave out here; set per-route)

  // Note: CSP is produced in @bowdoin/security/csp to ensure nonce integration with Next’s App Router.

  // Minor sanity: avoid obviously wrong origin values if passed accidentally.
  if (origin && !/^https?:\/\//i.test(origin)) {
    // tslint:disable-next-line:no-console
    globalThis.console?.warn?.('[security/headers] Provided origin does not look absolute:', origin);
  }

  return headers;
}

export const securityHeaders = createSecurityHeaders;

/**
 * Merge security headers into an existing Headers-like object without clobbering
 * any keys the caller already set (caller wins).
 */
export function mergeSecurityHeaders<T extends Headers | NodeFetchHeaders | Record<string, string>>(
  target: T,
  options?: SecurityHeaderOptions
): T {
  const sec = createSecurityHeaders(options);
  if (isHeadersMutable(target)) {
    for (const [k, v] of Object.entries(sec)) {
      const exists = typeof target.has === 'function' ? target.has(k) : false;
      if (!exists) target.set(k, v);
    }
    return target;
  }
  const merged: Record<string, string> = { ...sec, ...(target as Record<string, string>) };
  return merged as T;
}

/**
 * Utility for Next.js `next.config.mjs` to attach headers via the `headers()` function.
 * This returns a standard set for all routes. You can add per-path policies in your app config.
 */
export function nextSecurityHeaders(options?: SecurityHeaderOptions): Array<{
  source: string;
  headers: Array<{ key: string; value: string }>;
}> {
  const sec = createSecurityHeaders(options);
  return [
    {
      source: '/:path*',
      headers: Object.entries(sec).map(([key, value]) => ({ key, value }))
    }
  ];
}

/**
 * Best-effort cleanup to remove known framework/server leakage headers before sending a response.
 * Call in Edge Middleware or a fetch proxy if you need to strip upstream values.
 */
export function stripServerHeaders<T extends Headers | NodeFetchHeaders>(h: T): T {
  const drop = [
    'Server',
    'X-Powered-By',
    'X-AspNet-Version',
    'X-AspNetMvc-Version',
    'X-Generator',
    'X-Drupal-Cache',
    'X-Runtime'
  ];
  for (const k of drop) {
    if (typeof (h as { delete?: (key: string) => void }).delete === 'function') {
      h.delete(k);
    }
  }
  return h;
}
