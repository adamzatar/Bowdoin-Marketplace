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

type Origin = string;

type EnvSource = Record<string, string | undefined>;

const runtimeEnv: EnvSource =
  (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};

const boolFromEnv = (key: string, fallback = false): boolean => {
  const raw = runtimeEnv[key];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
};

const stringFromEnv = (key: string, fallback = ""): string => runtimeEnv[key] ?? fallback;

const arrayFromEnv = (key: string): string[] =>
  stringFromEnv(key)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

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
  arr.filter(Boolean) as T[];

const asOrigin = (urlOrHost: string): string => {
  if (!urlOrHost) return '';
  try {
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
 */
const DEFAULT_ANALYTICS: string[] = (() => {
  const host = stringFromEnv('ANALYTICS_DOMAIN', 'https://plausible.io');
  return boolFromEnv('ENABLE_SEARCH_V2', false) ? [asOrigin(host)] : [];
})();

const DEFAULT_IMAGE_HOSTS: string[] = [
  stringFromEnv('S3_BUCKET_HOST') ? asOrigin(stringFromEnv('S3_BUCKET_HOST')) : undefined,
  ...arrayFromEnv('NEXT_PUBLIC_IMAGE_HOSTS').map(asOrigin),
].filter(Boolean) as string[];

const DEFAULT_OKTA_ISSUER = stringFromEnv('OKTA_ISSUER', '');
const DEFAULT_UPGRADE_INSECURE = stringFromEnv('NODE_ENV', 'development') === 'production';

/** Build a hardened yet practical CSP for Next.js App Router. */
export function buildCSP({
  nonce,
  allow,
  oktaIssuer = DEFAULT_OKTA_ISSUER,
  imageHosts = DEFAULT_IMAGE_HOSTS,
  analyticsHosts = DEFAULT_ANALYTICS,
  upgradeInsecure = DEFAULT_UPGRADE_INSECURE,
  reportToGroup,
  enableCspReporting = Boolean(reportToGroup),
  strict,
}: CspBuildOptions = {}): CspPolicy {
  const self = `'self'`;
  const none = `'none'`;

  const scriptBase: string[] = [self];

  if (nonce) scriptBase.push(`'nonce-${nonce}'`);

  if (strict?.strictDynamic) {
    scriptBase.push(`'strict-dynamic'`);
    scriptBase.push('https:');
  }

  const styleBase: string[] = [self];
  if (!strict?.disallowInlineStyles) styleBase.push(`'unsafe-inline'`);
  if (nonce) styleBase.push(`'nonce-${nonce}'`);

  const imgBase: string[] = [self, 'data:', 'blob:', ...imageHosts.map(asOrigin)];

  const connectBase: string[] = [self, 'https:', 'wss:', ...analyticsHosts.map(asOrigin)];

  const frameBase: string[] = filterTruthy([oktaIssuer && asOrigin(oktaIssuer)]);

  const workerBase: string[] = [self, 'blob:'];

  const fontBase: string[] = [self, 'data:'];

  const directives: CspPolicy['directives'] = {
    'default-src': [self],
    'script-src': scriptBase,
    'style-src': styleBase,
    'img-src': uniq(imgBase),
    'connect-src': uniq(connectBase),
    'object-src': [none],
    'base-uri': [self],
    'frame-ancestors': [none],
    'font-src': uniq(fontBase),
    'media-src': [self, 'blob:', 'data:'],
    'worker-src': uniq(workerBase),
    'prefetch-src': [self],
    'form-action': [self],
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
    directives['report-to'] = [reportToGroup];
  }

  if (strict?.requireTrustedTypes) {
    directives['require-trusted-types-for'] = [`'script'`];
  }

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
    'report-uri',
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

export function cspHeader(policy: CspPolicy): [key: string, value: string] {
  return ['Content-Security-Policy', serializeCSP(policy)];
}

export function cspMetaTag(policy: CspPolicy): string {
  const content = serializeCSP(policy).replace(/"/g, '&quot;');
  return `<meta http-equiv="Content-Security-Policy" content="${content}">`;
}

export function buildAndSerializeCSP(opts?: CspBuildOptions): string {
  return serializeCSP(buildCSP(opts));
}

export function defaultCSP(nonce?: string): CspPolicy {
  return buildCSP({
    ...(nonce ? { nonce } : {}),
    oktaIssuer: stringFromEnv('OKTA_ISSUER', ''),
    imageHosts: DEFAULT_IMAGE_HOSTS,
    analyticsHosts: DEFAULT_ANALYTICS,
    upgradeInsecure: DEFAULT_UPGRADE_INSECURE,
    reportToGroup: 'default',
    enableCspReporting: false,
    strict: {
      strictDynamic: false,
      disallowInlineStyles: false,
      requireTrustedTypes: false,
    },
  });
}

export const buildContentSecurityPolicy = buildCSP;
