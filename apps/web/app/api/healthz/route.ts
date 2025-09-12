// apps/web/app/api/healthz/route.ts
//
// Liveness probe: fast, side-effect free, does NOT touch external deps.
// Use /readyz for deeper dependency checks.

import process from 'node:process';

import { logger } from '@bowdoin/observability/logger';

export const runtime = 'nodejs'; // ensure Node runtime (process is available)
export const dynamic = 'force-dynamic'; // never statically optimize
export const revalidate = 0;

function nowISO(): string {
  return new Date().toISOString();
}

function getCommitSha(): string | undefined {
  return (
    process.env.GIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.SOURCE_VERSION || // Heroku-style
    undefined
  );
}

function getRegion(): string | undefined {
  return (
    process.env.FLY_REGION ||
    process.env.VERCEL_REGION ||
    process.env.AWS_REGION ||
    process.env.GOOGLE_CLOUD_REGION ||
    process.env.REGION ||
    undefined
  );
}

function getUptimeSeconds(): number | undefined {
  try {
    return typeof process.uptime === 'function' ? Math.round(process.uptime()) : undefined;
  } catch {
    return undefined;
  }
}

const baseHeaders: HeadersInit = {
  'content-type': 'application/json; charset=utf-8',
  // liveness endpoints should not be cached by proxies/CDNs
  'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  pragma: 'no-cache',
  expires: '0',
};

export function GET(): Response {
  const payload = {
    ok: true,
    status: 'healthy' as const,
    service: 'web',
    time: nowISO(),
    uptimeSeconds: getUptimeSeconds(),
    version: process.env.npm_package_version || undefined,
    commit: getCommitSha(),
    region: getRegion(),
    // helpful infra hints (all optional)
    env: process.env.NODE_ENV || 'development',
  };

  // lightweight structured log for probes
  logger.info({ probe: 'healthz', ...payload }, 'healthz probe');

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: baseHeaders,
  });
}

export function HEAD(): Response {
  // Minimal HEAD response for load balancers
  return new Response(null, {
    status: 204,
    headers: {
      ...baseHeaders,
      'content-length': '0',
    },
  });
}
