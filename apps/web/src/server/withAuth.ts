// apps/web/src/server/withAuth.ts

/* ───────────────────────────── JSON error helper ───────────────────────────── */
function jsonError(
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({ ok: false, error: code, ...(extra ?? {}) }, null, 0),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, private",
        pragma: "no-cache",
        expires: "0",
        vary: "Cookie",
      },
    },
  );
}

/* ───────────────────────────── Types ───────────────────────────── */

import type {
  Session as SharedSession,
  SessionUserLike as SharedSessionUserLike,
  OptionalAuthContext as SharedOptionalAuthContext,
  StrictAuthContext as SharedStrictAuthContext,
} from "./index";

type SessionUserLike = SharedSessionUserLike;
type Session = SharedSession;
type StrictAuthContext = SharedStrictAuthContext;
type OptionalAuthContext = SharedOptionalAuthContext;

export type { SessionUserLike, Session, StrictAuthContext, OptionalAuthContext };

type LooseSessionUserLike = Partial<SessionUserLike> & Record<string, unknown>;
type LooseSession = { user?: LooseSessionUserLike } & Record<string, unknown>;

// Some routes import `Context`; keep a compatible alias (optional mode)
export type Context = OptionalAuthContext;

export type AuthOk = { ok: true; session: Session; userId: string };
export type AuthErr = { ok: false; error: Response };
export type AuthResult = AuthOk | AuthErr;

export type WithAuthOptions = {
  /**
   * Require at least one of these roles.
   * Comparison is case-insensitive.
   */
  roles?: string[];
  /**
   * Additional authorization hook. Return false to reject.
   */
  authorize?: (session: Session) => boolean | Promise<boolean>;
  /**
   * If true, session is optional. `ctx.userId`/`ctx.session` may be undefined.
   * `ctx.ip` is always present.
   */
  optional?: boolean;
};

/* ─────────────────────── Internal: NextAuth loader ─────────────────────── */

async function getServerSessionSafe(): Promise<LooseSession | null> {
  try {
    // Dynamic import so bundlers don’t require next-auth at build time.
    const na = (await import("next-auth")) as unknown as {
      getServerSession?: (
        ...args: unknown[]
      ) => Promise<unknown>;
    };

    if (typeof na.getServerSession !== "function") return null;

    // Try to load our published auth options (optional).
    let authOptions: unknown | undefined;
    try {
      // This subpath exists after @bowdoin/auth is built/published in the workspace.
      // eslint-disable-next-line import/no-unresolved
      const mod = (await import("@bowdoin/auth/nextauth")) as {
        authOptions?: unknown;
      };
      authOptions = mod?.authOptions;
    } catch {
      authOptions = undefined;
    }

    const raw = authOptions
      ? await na.getServerSession(authOptions as never)
      : await na.getServerSession();

    // We keep it loose here; routes can further narrow if needed.
    return (raw ?? null) as LooseSession | null;
  } catch {
    return null;
  }
}

/* ───────────────────────────── IP utils ───────────────────────────── */

function parseForwardedFor(value: string | null): string | null {
  if (!value) return null;
  // X-Forwarded-For can be a comma-separated list; first is the client IP.
  const first = value.split(",")[0]?.trim();
  return first || null;
}

function getIp(req: Request): string {
  // Trust typical proxies (Vercel/CloudFront/Nginx/etc.)
  const h = req.headers;
  const xff = parseForwardedFor(h.get("x-forwarded-for"));
  if (xff) return xff;
  const xri = h.get("x-real-ip");
  if (xri) return xri;
  // Node/Next local dev fallback
  return "127.0.0.1";
}

/* ─────────────────────── Public primitives ─────────────────────── */

export async function getSession(): Promise<LooseSession | null> {
  return await getServerSessionSafe();
}

/**
 * Helper for routes that want to gate early without the wrapper.
 */
export async function requireSession(): Promise<AuthResult> {
  const sess = await getSession();
  const userId = sess?.user?.id ?? null;
  if (!userId) return unauthorized();
  return { ok: true, session: sess as Session, userId: String(userId) };
}

/**
 * Role check helper (case-insensitive).
 */
export async function requireRole(required: string | string[]): Promise<AuthResult> {
  const auth = await requireSession();
  if (!auth.ok) return auth;

  const need = Array.isArray(required) ? required : [required];
  if (!userHasAnyRole(auth.session, need)) {
    return forbidden("forbidden:insufficient_role", { required: need });
  }
  return auth;
}

/**
 * Usage (strict):
 *   export const POST = withAuth({ roles: ["ADMIN"] })(
 *     async (req, ctx) => Response.json({ ok: true })
 *   );
 *
 * Usage (optional):
 *   export const GET = withAuth({ optional: true })(
 *     async (req, ctx) => Response.json({ userId: ctx.userId ?? null, ip: ctx.ip })
 *   );
 */
export function withAuth<TCtx extends object = { params?: Record<string, string> }>(
  options: WithAuthOptions = {},
) {
  type AugmentedCtx = TCtx & {
    session?: Session;
    userId?: string;
    ip: string;
  };

  type Handler = (req: Request, ctx: AugmentedCtx) => Promise<Response> | Response;

  return (handler: Handler) =>
    (async (req: Request, ctx: TCtx): Promise<Response> => {
      const ip = getIp(req);
      const sess = await getSession();

      if (options.optional) {
        const augmented: AugmentedCtx = { ...ctx, ip } as AugmentedCtx;
        if (sess) {
          augmented.session = sess as Session;
          const optionalUserId = sess.user?.id;
          if (optionalUserId) {
            augmented.userId = String(optionalUserId);
          }
        }
        return handler(req, augmented);
      }

      const userId = sess?.user?.id ?? null;
      if (!userId) return unauthorized().error;

      if (options.roles?.length && !userHasAnyRole(sess as Session, options.roles)) {
        return forbidden("forbidden:insufficient_role", { required: options.roles }).error;
      }

      if (options.authorize) {
        const ok = await options.authorize(sess as Session);
        if (!ok) return forbidden("forbidden:not_authorized").error;
      }

      const augmentedCtx: AugmentedCtx = {
        ...ctx,
        ip,
        session: sess as Session,
        userId: String(userId),
      };

      return handler(req, augmentedCtx);
    }) as Handler;
}

/* ───────────────────────────── Helpers ─────────────────────────── */

function unauthorized(): AuthErr {
  return { ok: false, error: jsonError(401, "unauthorized", { hint: "Sign in required." }) };
}

function forbidden(code = "forbidden", extra?: Record<string, unknown>): AuthErr {
  return { ok: false, error: jsonError(403, code, extra) };
}

function userHasAnyRole(session: Session, required: string[]): boolean {
  const one = session.user?.role ?? null;
  const many = session.user?.roles ?? (one ? [one] : []);
  if (!many || many.length === 0) return false;
  const have = new Set(
    many
      .filter((r): r is string => typeof r === "string" && r.length > 0)
      .map((r) => r.toUpperCase()),
  );
  return required.some((r) => have.has(String(r).toUpperCase()));
}
