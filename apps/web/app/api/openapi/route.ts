// apps/web/app/api/openapi/route.ts
//
// Serves the canonical OpenAPI spec from @bowdoin/contracts.
// - Content negotiation (JSON by default; YAML with ?format=yaml or Accept header)
// - Strong ETag + 304 handling
// - CORS-friendly for docs tools and validators
// - Fast and side-effect free

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { NextResponse } from 'next/server';

import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* ---------- helpers ---------- */

function pickFormat(req: NextRequest): 'json' | 'yaml' {
  const url = new URL(req.url);
  const qp = (url.searchParams.get('format') || '').toLowerCase();
  if (qp === 'yaml' || qp === 'yml') return 'yaml';

  const accept = req.headers.get('accept') || '';
  if (/\b(application|text)\/(yaml|x-yaml)\b/.test(accept)) return 'yaml';
  return 'json';
}

function etagOf(payload: string): string {
  // Strong ETag (hash of byte content)
  const hash = createHash('sha1').update(payload, 'utf8').digest('hex');
  return `"sha1-${hash}"`;
}

function baseHeaders(extra?: Record<string, string>) {
  return {
    // allow cheap revalidation and CDN friendliness
    'cache-control': 'public, max-age=0, must-revalidate',
    // permissive CORS for tooling (Swagger UI, Redoc, validators, etc.)
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Accept, Content-Type, If-None-Match',
    ...extra,
  };
}

/** Render spec as JSON by loading the YAML and parsing it at runtime. */
async function renderJSON(): Promise<{ body: string; contentType: string }> {
  const require = createRequire(import.meta.url);
  const yamlPath = require.resolve('@bowdoin/contracts/openapi/openapi.yaml');
  const yamlSource = await readFile(yamlPath, 'utf8');
  // Lazy import so parser isn't bundled unnecessarily elsewhere
  const { default: YAML } = await import('yaml');
  const obj = YAML.parse(yamlSource);
  const body = JSON.stringify(obj);
  return { body, contentType: 'application/json; charset=utf-8' };
}

/** Render the hand-authored YAML directly. */
async function renderYAML(): Promise<{ body: string; contentType: string }> {
  const require = createRequire(import.meta.url);
  const yamlPath = require.resolve('@bowdoin/contracts/openapi/openapi.yaml');
  const body = await readFile(yamlPath, 'utf8');
  return { body, contentType: 'application/yaml; charset=utf-8' };
}

async function buildPayload(req: NextRequest) {
  const fmt = pickFormat(req);
  const { body, contentType } = fmt === 'yaml' ? await renderYAML() : await renderJSON();
  const etag = etagOf(body);
  return { fmt, body, contentType, etag };
}

/* ---------- handlers ---------- */

export async function GET(req: NextRequest) {
  const { body, contentType, etag } = await buildPayload(req);

  // 304 short-circuit
  const inm = req.headers.get('if-none-match');
  if (inm && inm === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: baseHeaders({
        etag,
        'content-type': contentType, // helps some proxies
      }),
    });
  }

  return new NextResponse(body, {
    status: 200,
    headers: baseHeaders({
      etag,
      'content-type': contentType,
      'content-length': Buffer.byteLength(body, 'utf8').toString(),
    }),
  });
}

export async function HEAD(req: NextRequest) {
  const { contentType, etag, body } = await buildPayload(req);
  // No body, only headers
  return new NextResponse(null, {
    status: 200,
    headers: baseHeaders({
      etag,
      'content-type': contentType,
      'content-length': Buffer.byteLength(body, 'utf8').toString(),
    }),
  });
}

export async function OPTIONS() {
  // CORS preflight
  return new NextResponse(null, {
    status: 204,
    headers: baseHeaders(),
  });
}
