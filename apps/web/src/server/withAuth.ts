// apps/web/src/server/withAuth.ts

/* Minimal JSON error helper (avoid unresolved imports) */
function jsonError(status: number, code: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error: code, ...(extra ?? {}) }, null, 0), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
      expires: '0',
      vary: 'Cookie',
    },
  });
}

/* ───────────────────────────── Types ───────────────────────────── */

export type Session = {
  user?: {
    id?: string | null;
    role?: string | null;
    roles?: string[] | null;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type AuthOk = { ok: true; session: Session; userId: string };
export type AuthErr = { ok: false; error: Response };
export type AuthResult = AuthOk | AuthErr;

export type WithAuthOptions = {
  roles?: string[];
  authorize?: (session: Session) => boolean | Promise<boolean>;
  optional?: boolean;
};

/* ─────────────────────── Internal: next-auth loader ─────────────────────── */

async function getServerSessionSafe(): Promise<Session | null> {
  try {
    // Dynamic import so bundlers don’t require next-auth at build time.
    // eslint-disable-next-line import/no-extraneous-dependencies
    const na = (await import('next-auth')) as {
      getServerSession?: ((...args: any[]) => Promise<unknown>) | undefined;
    };
    if (!na?.getServerSession) return null;

    // Try to load your published auth options (optional).
    // We suppress the resolver lint because this subpath exists only after @bowdoin/auth builds.
    let authOptions: unknown | undefined;
    try {
      // eslint-disable-next-line import/no-unresolved
      authOptions = (await import('@bowdoin/auth/nextauth')).authOptions;
    } catch {
      authOptions = undefined;
    }

    const raw = authOptions ? await na.getServerSession(authOptions) : await na.getServerSession();
    return (raw ?? null) as Session | null;
  } catch {
    return null;
  }
}

/* ─────────────────────── Public primitives ─────────────────────── */

export async function getSession(): Promise<Session | null> {
  return await getServerSessionSafe();
}

export async function requireSession(): Promise<AuthResult> {
  const sess = await getSession();
  const userId = sess?.user?.id ?? null;
  if (!userId) return unauthorized();
  return { ok: true, session: sess as Session, userId: String(userId) };
}

export async function requireRole(required: string | string[]): Promise<AuthResult> {
  const auth = await requireSession();
  if (!auth.ok) return auth;

  const need = Array.isArray(required) ? required : [required];
  if (!userHasAnyRole(auth.session, need)) {
    return forbidden('forbidden:insufficient_role', { required: need });
  }
  return auth;
}

/**
 * Usage:
 *   export const POST = withAuth({ roles: ["ADMIN"] })(
 *     async (req, ctx) => { return Response.json({ ok: true }) }
 *   );
 */
export function withAuth<TCtx extends object = { params?: Record<string, string> }>(
  options: WithAuthOptions = {},
) {
  type AugmentedCtx = TCtx & { session?: Session; userId?: string };
  type Handler = (req: Request, ctx: AugmentedCtx) => Promise<Response> | Response;

  return (handler: Handler) =>
    (async (req: Request, ctx: TCtx): Promise<Response> => {
      const sess = await getSession();

      if (options.optional) {
        const augmented: AugmentedCtx = sess
          ? { ...ctx, session: sess, userId: sess.user?.id ? String(sess.user.id) : undefined }
          : { ...ctx };
        return handler(req, augmented);
      }

      const userId = sess?.user?.id ?? null;
      if (!userId) return unauthorized().error;

      if (options.roles?.length) {
        if (!userHasAnyRole(sess as Session, options.roles)) {
          return forbidden('forbidden:insufficient_role', { required: options.roles }).error;
        }
      }

      if (options.authorize) {
        const ok = await options.authorize(sess as Session);
        if (!ok) return forbidden('forbidden:not_authorized').error;
      }

      const augmentedCtx: AugmentedCtx = { ...ctx, session: sess as Session, userId: String(userId) };
      return handler(req, augmentedCtx);
    }) as Handler;
}

/* ───────────────────────────── Helpers ─────────────────────────── */

function unauthorized(): AuthErr {
  return { ok: false, error: jsonError(401, 'unauthorized', { hint: 'Sign in required.' }) };
}

function forbidden(code = 'forbidden', extra?: Record<string, unknown>): AuthErr {
  return { ok: false, error: jsonError(403, code, extra) };
}

function userHasAnyRole(session: Session, required: string[]): boolean {
  const one = session.user?.role ?? null;
  const many = session.user?.roles ?? (one ? [one] : []);
  if (!many || many.length === 0) return false;
  const have = new Set(many.filter(Boolean).map((r) => String(r).toUpperCase()));
  return required.some((r) => have.has(String(r).toUpperCase()));
}