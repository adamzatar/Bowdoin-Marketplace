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

import { withAuth, rateLimit, jsonError } from '@/server';

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

export const GET = withAuth()(async (_req, ctx) => {
  const userSession = ctx.session?.user;
  const userId = ctx.userId ?? userSession?.id;
  if (!userId || !userSession) return jsonError(401, 'unauthorized');

  // Lightweight per-user rate limit (fallback to IP if somehow no user id)
  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || '0.0.0.0';
  const key = `users:me:${userId ?? ip}`;

  try {
    await rateLimit(key, 60, 60); // 60 reqs / 60s
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Build a stable, public-safe payload.
  // Prefer values from the session; enrich here later if you load from DB.
  const user = {
    id: userId,
    email: userSession.email ?? null,
    name: userSession.name ?? null,
    image: userSession.image ?? null,
    roles: userSession.roles ?? [], // e.g., ["user"], ["admin"]
    affiliation: userSession.affiliation ?? null,
    audience: userSession.audience ?? 'public',
    createdAt: userSession.createdAt ?? null,
    updatedAt: userSession.updatedAt ?? null,
  };

  return new Response(JSON.stringify({ user }, null, 0), {
    status: 200,
    headers: noStoreHeaders(),
  });
});
