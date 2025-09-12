// apps/web/app/api/users/me/route.ts
//
// Returns the authenticated user's profile snapshot for the current session.
// - Protected: requires a valid NextAuth session
// - Rate-limited per user (fallback to IP)
// - Non-cacheable (private user data)
// - Consistent JSON shape for clients
//

import { headers } from 'next/headers';

import type { NextRequest } from 'next/server';

import { jsonError } from '../../../../src/server/handlers/errorHandler';
import { rateLimit } from '../../../../src/server/rateLimit';
import { requireSession } from '../../../../src/server/withAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function noStoreHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate, private',
    pragma: 'no-cache',
    expires: '0',
    vary: 'Cookie',
  };
}

export async function GET(_req: NextRequest) {
  // Require an authenticated session
  const auth = await requireSession();
  if (!auth.ok) return auth.error;

  const session = auth.session;

  // Lightweight per-user rate limit (fallback to IP if somehow no user id)
  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || '0.0.0.0';
  const key = `users:me:${session.user?.id ?? ip}`;

  try {
    await rateLimit(key, 60, 60); // 60 reqs / 60s
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Build a stable, public-safe payload.
  // Prefer values from the session; enrich here later if you load from DB.
  const user = {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    roles: session.user.roles ?? [], // e.g., ["user"], ["admin"]
    affiliation: session.user.affiliation ?? null, // { campus, status, verifiedAt } shape if present
    audience: session.user.audience ?? 'public', // e.g., "public" | "community"
    createdAt: session.user.createdAt ?? null,
    updatedAt: session.user.updatedAt ?? null,
  };

  return new Response(JSON.stringify({ user }, null, 0), {
    status: 200,
    headers: noStoreHeaders(),
  });
}
