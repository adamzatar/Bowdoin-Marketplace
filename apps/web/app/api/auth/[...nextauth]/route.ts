// apps/web/app/api/auth/[...nextauth]/route.ts
//
// App Router binding for NextAuth.
// We delegate all logic to the shared @bowdoin/auth package so the API layer
// stays thin and versionable across apps.

export const runtime = 'nodejs'; // NextAuth relies on Node APIs
export const dynamic = 'force-dynamic'; // sessions are per-request
export const revalidate = 0;

export { GET, POST } from '@bowdoin/auth/nextauth';

// (Optional) Helpful for CORS preflights from native/mobile clients hitting this endpoint.
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With, Cookie',
      'access-control-allow-credentials': 'true',
      'cache-control': 'no-store',
    },
  });
}
