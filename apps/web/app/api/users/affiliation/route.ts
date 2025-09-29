// apps/web/app/api/users/affiliation/route.ts
//
// Update the authenticated user's affiliation preferences (campus + audience).
// Verification of the affiliation (e.g., via school email) is handled in the
// dedicated endpoints:
//   - POST /api/users/verification/request
//   - POST /api/users/verification/confirm
//
// This route is strictly for saving the user's affiliation metadata and desired
// audience visibility. It is protected, rate-limited, validates input with Zod,
// and emits an audit trail event.
//

import { headers } from 'next/headers';
import { z } from 'zod';

import type { NextRequest } from 'next/server';

import { requireSession, rateLimit, Handlers } from '@/src/server';

const { emitAuditEvent, jsonError } = Handlers;

// If you already export a shared schema from contracts, you can switch to:
//   import { AffiliationUpdateInput } from "@bowdoin/contracts/schemas/affiliation";
//   const BodySchema = AffiliationUpdateInput;
// For now we keep a local schema that aligns with contracts.
const BodySchema = z
  .object({
    campus: z
      .string()
      .trim()
      .min(2, 'campus must be at least 2 characters')
      .max(100, 'campus must be at most 100 characters'),
    role: z.enum(['student', 'staff', 'faculty', 'alumni', 'guest']).default('student'),
    audience: z.enum(['public', 'community']).default('community'),
    // optional free-form note or program (bounded + sanitized by length)
    program: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

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

export async function POST(req: NextRequest) {
  // Require an authenticated session
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const session = auth.session;

  // Rate limit (per-user with IP fallback)
  const hdrs = headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || '0.0.0.0';
  const rlKey = `users:affiliation:update:${session.user?.id ?? ip}`;

  try {
    await rateLimit(rlKey, 20, 60); // 20 writes/minute
  } catch {
    return jsonError(429, 'Too many requests');
  }

  // Validate body
  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    body = BodySchema.parse(json);
  } catch (err) {
    const message =
      err instanceof z.ZodError ? err.errors.map((e) => e.message).join('; ') : 'invalid JSON';
    return jsonError(400, message);
  }

  // TODO: persist to DB — example:
  // const db = getDb(); await db.user.update({ where: { id: session.user.id }, data: { ... } });
  // For now, we echo back the normalized payload.

  // Emit an audit event (non-blocking)
  emitAuditEvent('user.affiliation.updated', {
    userId: session.user.id,
    campus: body.campus,
    role: body.role,
    audience: body.audience,
    program: body.program ?? null,
    actor: { type: 'user', id: session.user.id },
    ip,
    ua: hdrs.get('user-agent') ?? undefined,
  }).catch(() => {
    // best-effort audit; do not fail request
  });

  return new Response(
    JSON.stringify(
      {
        ok: true,
        affiliation: {
          campus: body.campus,
          role: body.role,
          audience: body.audience,
          program: body.program ?? null,
          // status is managed by verification flow; expose as-is from session for clients
          status: session.user?.affiliation?.status ?? 'unverified',
          verifiedAt: session.user?.affiliation?.verifiedAt ?? null,
        },
      },
      null,
      0,
    ),
    { status: 200, headers: noStoreHeaders() },
  );
}

// Optional: support GET to return the current session's affiliation snapshot.
// Handy for clients to hydrate forms without hitting another endpoint.
export async function GET(_req: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.error;
  const { user } = auth.session;

  const affiliation = {
    campus: user?.affiliation?.campus ?? null,
    role: user?.affiliation?.role ?? null,
    audience: user?.audience ?? 'public',
    status: user?.affiliation?.status ?? 'unverified',
    verifiedAt: user?.affiliation?.verifiedAt ?? null,
    program: user?.affiliation?.program ?? null,
  };

  return new Response(JSON.stringify({ affiliation }, null, 0), {
    status: 200,
    headers: noStoreHeaders(),
  });
}
