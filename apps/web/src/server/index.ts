// apps/web/src/server/index.ts
/**
 * Server barrel (ESM / NodeNext).
 * Exposes auth helpers, route helpers (handlers), validators, and rate limiting
 * in both lowercase and PascalCase aliases to preserve backwards compatibility.
 */

// Auth
export { withAuth } from "./withAuth";

export type SessionUserLike = {
  id: string;
  roles?: string[];             // plural roles (newer code paths)
  role?: string | null;         // singular role (legacy routes still read this)
  audience?: "public" | "community";
  affiliation?:
    | {
        campus?: string | null;
        role?: string | null;
        status?: "verified" | "unverified" | "rejected";
        verifiedAt?: Date | null;
        program?: string | null;
      }
    | null;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

export type Session = { user?: SessionUserLike };

export type StrictAuthContext = { userId: string; session: Session; ip: string };
export type OptionalAuthContext = { userId?: string; session?: Session; ip: string };

/** Convenience guard some routes import directly (throws 401 Response). */
export function requireSession<T extends OptionalAuthContext>(
  ctx: T
): asserts ctx is T & StrictAuthContext {
  if (!ctx?.session?.user?.id) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
}

/* -------------------- handlers (named + alias objects) -------------------- */
import * as handlersNS from "./handlers/index";
export * from "./handlers/index";         // keep named exports
export const handlers = handlersNS;          // alias object
export { handlers as Handlers };             // legacy PascalCase alias
export type Handlers = typeof handlersNS;

/* -------------------- validators (named + alias objects) ------------------ */
import * as validatorsNS from "./validators";
export * from "./validators";             // keep named exports
export const validators = validatorsNS;      // alias object
export { validators as Validators };         // legacy PascalCase alias
export type Validators = typeof validatorsNS;

/* -------------------- passthroughs --------------------------------------- */
export { rateLimit } from "./rateLimit";
