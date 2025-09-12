/**
 * @module @bowdoin/security/csp
 * Content Security Policy builder with Next.js nonce support.
 *
 * Works in Middleware, Route Handlers, and server components.
 *
 * Example (Middleware):
 *   import { NextResponse } from 'next/server';
 *   import { buildCSP, cspHeader } from '@bowdoin/security/csp';
 *
 *   export function middleware(req: NextRequest) {
 *     const nonce = crypto.randomUUID().replace(/-/g, '');
 *     const headers = new Headers(req.headers);
 *     headers.set(...cspHeader(buildCSP({ nonce })));
 *     const res = NextResponse.next({ request: { headers } });
 *     // expose nonce to the app (e.g., as a header that you read in layout.tsx)
 *     res.headers.set('x-csp-nonce', nonce);
 *     return res;
 *   }
 *
 * Example (Route Handler):
 *   const nonce = crypto.randomUUID().replace(/-/g, '');
 *   const policy = buildCSP({ nonce });
 *   return new Response('ok', { headers: new Headers([cspHeader(policy)]) });
 */

import { env } from "@bowdoin/config/env";
import * as flags from "@bowdoin/config/flags";



type Origin = string;

export interface CspBuildOptions {
  /** Nonce for <script> and (optionally) inline styles (Next’s Script/nonce). */
  nonce?: string;
  /** Additional allowed sources per directive. */
  allow?: Partial<{
    script: Origin[];
    style: Origin[];
    img: Origin[];
    connect: Origin[];
    font: Origin[];
    media: Origin[];
    frame: Origin[];
    worker: Origin[];
    prefetch: Origin[];
  }>;
  /** Okta issuer URL to allow for redirects/oauth frames if required. */
  oktaIssuer?: string;
  /** S3/CloudFront (images) — hostname(s) like "s3.amazonaws.com" or "cdn.example.com". */
  imageHosts?: Origin[];
  /** Allow Plausible/analytics endpoint(s). */
  analyticsHosts?: Origin[];
  /** If true, add `upgrade-insecure-requests` (only safe when app is fully HTTPS). */
  upgradeInsecure?: boolean;
  /** If set, add reporting headers via @bowdoin/security/headers Reporting-Endpoints. */
  reportToGroup?: string; // e.g., "default"
  /** If provided, include `report-to`/`report-uri` CSP directives pointing to that group. */
  enableCspReporting?: boolean;
  /**
   * Strict mode toggles:
   * - strictDynamic: add `'strict-dynamic'` to script-src (requires nonces and modern browsers)
   * - disallowInlineStyles: drop 'unsafe-inline' from style-src; prefer nonce-based styles
   * - requireTrustedTypes: enforce Trusted Types for scripts (you must define a policy in app)
   */
  strict?: {
    strictDynamic?: boolean;
    disallowInlineStyles?: boolean;
    requireTrustedTypes?: boolean;
  };
}

export interface CspPolicy {
  /** Ordered map of directives → sources/tokens. */
  directives: Record<string, string[] | true>;
}

/** Utilities */
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
const filterTruthy = <T,>(arr: (T | false | null | undefined)[]) =>
  (arr.filter(Boolean) as unknown) as T[];

const asOrigin = (urlOrHost: string): string => {
  if (!urlOrHost) return '';
  try {
    // Accept bare hosts like "example.com" or with scheme
    if (!/^https?:\/\//i.test(urlOrHost)) {
      return `https://${urlOrHost.replace(/\/+$/, '')}`;
    }
    const u = new URL(urlOrHost);
    return `${u.protocol}//${u.host}`;
  } catch {
    return urlOrHost;
  }
};

/**
 * Default analytics hosts: include if an analytics domain is configured.
 * If you want a flag-based gate, wire it here using your flags utility.
 */
const DEFAULT_ANALYTICS: string[] = (() => {
  const host = process.env.ANALYTICS_DOMAIN || "https://plausible.io";
  return flags.isEnabled("ENABLE_SEARCH_V2") ? [asOrigin(host)] : [];
})();

const DEFAULT_IMAGE_HOSTS: string[] = [
  process.env.S3_BUCKET_HOST ? asOrigin(process.env.S3_BUCKET_HOST) : undefined,
  process.env.NEXT_PUBLIC_IMAGE_HOSTS ? asOrigin(process.env.NEXT_PUBLIC_IMAGE_HOSTS) : undefined,
].filter(Boolean) as string[];

/** Build a hardened yet practical CSP for Next.js App Router. */
export function buildCSP({
  nonce,
  allow,
  oktaIssuer = env.OKTA_ISSUER || '',
  imageHosts = DEFAULT_IMAGE_HOSTS,
  analyticsHosts = DEFAULT_ANALYTICS,
  upgradeInsecure = env.NODE_ENV === 'production',
  reportToGroup,
  enableCspReporting = Boolean(reportToGroup),
  strict
}: CspBuildOptions = {}): CspPolicy {
  const self = `'self'`;
  const none = `'none'`;

  const scriptBase: string[] = [self];

  // Next.js inline scripts will receive the nonce from <Script nonce> or automatic nonce plumbing.
  if (nonce) scriptBase.push(`'nonce-${nonce}'`);

  // Strict-Dynamic (modern hardening): allows scripts loaded by a trusted (nonce’d) script.
  if (strict?.strictDynamic) {
    scriptBase.push(`'strict-dynamic'`);
    // With strict-dynamic, you don't need to list CDNs; the nonce’d bootstrap governs trust.
    // Keep https: as a safety valve for backward compat if desired:
    scriptBase.push('https:');
  }

  // Style: Next often injects inline styles (for styled-jsx) unless disabled.
  // Safe default is to allow 'unsafe-inline'. To harden, set disallowInlineStyles=true and provide nonce’d styles.
  const styleBase: string[] = [self, strict?.disallowInlineStyles ? '' : `'unsafe-inline'`].filter(Boolean) as string[];
  if (nonce) styleBase.push(`'nonce-${nonce}'`);

  const imgBase: string[] = [
    self,
    'data:',
    'blob:',
    ...imageHosts.map(asOrigin)
  ];

  const connectBase: string[] = [
    self,
    'https:',
    'wss:', // Next dev / SSE / real-time
    ...analyticsHosts.map(asOrigin)
  ];

  // Frames: Okta may host pages in its domain for login flows; NextAuth uses redirects (not iframes).
  const frameBase: string[] = filterTruthy([oktaIssuer && asOrigin(oktaIssuer)]);

  const workerBase: string[] = [self, 'blob:'];

  const fontBase: string[] = [self, 'data:'];

  const directives: CspPolicy['directives'] = {
    'default-src': [self],
    // Allow scripts with nonce; avoid unsafe-eval unless absolutely necessary.
    'script-src': scriptBase,
    // Style policy
    'style-src': styleBase,
    // Images
    'img-src': uniq(imgBase),
    // Ajax/fetch/WS
    'connect-src': uniq(connectBase),
    // Disallow plugins
    'object-src': [none],
    // Base tag restrictions
    'base-uri': [self],
    // Disallow being framed (clickjacking); Next also uses X-Frame-Options DENY via headers.ts
    'frame-ancestors': [none],
    // Fonts
    'font-src': uniq(fontBase),
    // Media (images/video/audio uploads playback)
    'media-src': [self, 'blob:', 'data:'],
    // Workers
    'worker-src': uniq(workerBase),
    // Prefetch
    'prefetch-src': [self],
    // Form targets (Okta redirect back to our site)
    'form-action': [self]
  };

  if (frameBase.length > 0) {
    directives['frame-src'] = uniq(frameBase);
  } else {
    directives['frame-src'] = [self];
  }

  if (upgradeInsecure) {
    directives['upgrade-insecure-requests'] = true;
  }

  if (enableCspReporting && reportToGroup) {
    // When you also set Reporting-Endpoints via headers.ts, this links CSP to that group.
    directives['report-to'] = [reportToGroup];
    // Some user agents still read legacy report-uri; you can run a handler at /api/csp-report if desired.
    // directives['report-uri'] = ['/api/csp-report'];
  }

  if (strict?.requireTrustedTypes) {
    directives['require-trusted-types-for'] = [`'script'`];
    // You may also define a policy name: directives['trusted-types'] = ['your-policy-name'];
  }

  // Merge user-allowed extras
  if (allow) {
    if (allow.script?.length) directives['script-src'] = uniq([...(directives['script-src'] as string[]), ...allow.script.map(asOrigin)]);
    if (allow.style?.length) directives['style-src'] = uniq([...(directives['style-src'] as string[]), ...allow.style.map(asOrigin)]);
    if (allow.img?.length) directives['img-src'] = uniq([...(directives['img-src'] as string[]), ...allow.img.map(asOrigin)]);
    if (allow.connect?.length) directives['connect-src'] = uniq([...(directives['connect-src'] as string[]), ...allow.connect.map(asOrigin)]);
    if (allow.font?.length) directives['font-src'] = uniq([...(directives['font-src'] as string[]), ...allow.font.map(asOrigin)]);
    if (allow.media?.length) directives['media-src'] = uniq([...(directives['media-src'] as string[]), ...allow.media.map(asOrigin)]);
    if (allow.frame?.length) directives['frame-src'] = uniq([...(directives['frame-src'] as string[]), ...allow.frame.map(asOrigin)]);
    if (allow.worker?.length) directives['worker-src'] = uniq([...(directives['worker-src'] as string[]), ...allow.worker.map(asOrigin)]);
    if (allow.prefetch?.length) directives['prefetch-src'] = uniq([...(directives['prefetch-src'] as string[]), ...allow.prefetch.map(asOrigin)]);
  }

  return { directives };
}

/** Serialize to a CSP header string (directive order kept readable). */
export function serializeCSP(policy: CspPolicy): string {
  const order = [
    'default-src',
    'base-uri',
    'frame-ancestors',
    'script-src',
    'style-src',
    'img-src',
    'font-src',
    'connect-src',
    'media-src',
    'frame-src',
    'worker-src',
    'prefetch-src',
    'form-action',
    'require-trusted-types-for',
    'trusted-types',
    'upgrade-insecure-requests',
    'report-to',
    'report-uri'
  ];

  const lines: string[] = [];
  for (const key of order) {
    const val = policy.directives[key];
    if (!val) continue;
    if (val === true) {
      lines.push(key);
    } else if (Array.isArray(val) && val.length > 0) {
      lines.push(`${key} ${val.join(' ')}`);
    }
  }

  // Include any custom directives not in the default order
  for (const [k, v] of Object.entries(policy.directives)) {
    if (order.includes(k)) continue;
    if (v === true) {
      lines.push(k);
    } else if (Array.isArray(v) && v.length > 0) {
      lines.push(`${k} ${v.join(' ')}`);
    }
  }

  return lines.join('; ');
}

/** Tuple key/value ready to pass into Headers.set(...). */
export function cspHeader(policy: CspPolicy): [key: string, value: string] {
  return ['Content-Security-Policy', serializeCSP(policy)];
}

/** Build a `<meta httpEquiv="Content-Security-Policy" content="...">` string (for SSR fallback). */
export function cspMetaTag(policy: CspPolicy): string {
  const content = serializeCSP(policy).replace(/"/g, '&quot;');
  return `<meta http-equiv="Content-Security-Policy" content="${content}">`;
}

/** Convenience: build and serialize in one go. */
export function buildAndSerializeCSP(opts?: CspBuildOptions): string {
  return serializeCSP(buildCSP(opts));
}

/** Opinionated defaults for Bowdoin Marketplace, reading env. */
export function defaultCSP(nonce?: string): CspPolicy {
  return buildCSP({
    ...(nonce ? { nonce } : {}),
    oktaIssuer: env.OKTA_ISSUER,
    imageHosts: DEFAULT_IMAGE_HOSTS,
    analyticsHosts: DEFAULT_ANALYTICS,
    upgradeInsecure: env.NODE_ENV === 'production',
    reportToGroup: 'default',
    enableCspReporting: false, // enable when you wire reporting endpoints
    strict: {
      strictDynamic: false, // flip to true after verifying script nonces across the app
      disallowInlineStyles: false, // flip to true if all styles are CSP-compliant
      requireTrustedTypes: false // flip after adding a TT policy in the app
    }
  });
}
export const buildContentSecurityPolicy = buildCSP;
