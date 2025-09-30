// apps/web/types/shims-server.d.ts
// Lightweight ambient types so imports from "@/server" resolve
// even before all internal packages are built.

declare module "@/server" {
  /* ================= Session / Context ================= */

  export type SessionUserLike = {
    id: string;
    // keep both for backward-compat – some routes check `role`, others `roles`
    role?: string | null;
    roles?: string[] | null;

    audience?: "public" | "community";
    affiliation?: {
      campus?: string | null;
      role?: string | null;
      status?: "unverified" | "verified" | "rejected" | string;
      verifiedAt?: Date | null;
      program?: string | null;
    } | null;

    email?: string | null;
    name?: string | null;
    image?: string | null;
    createdAt?: Date | null;
    updatedAt?: Date | null;
  };

  export type Session = { user?: SessionUserLike | undefined };

  export type StrictAuthContext = {
    userId: string;
    ip?: string;
    session: Session;
  };

  export type OptionalAuthContext = {
    userId?: string;
    ip?: string;
    session?: Session;
  };

  /* ================= withAuth (curried) =================
     Runtime usage:  withAuth(options?)(handler)
     - optional mode injects ctx.session/userId if present
     - strict mode enforced by options.roles/authorize at runtime
  */
  export type WithAuthOptions = {
    roles?: string[];
    authorize?: (session: Session) => boolean | Promise<boolean>;
    optional?: boolean;
  };

  export function withAuth<
    TCtx extends object = { params?: Record<string, string> }
  >(
    options?: WithAuthOptions
  ): (
    handler: (req: Request, ctx: TCtx & { session?: Session; userId?: string }) => Promise<Response> | Response
  ) => (req: Request, ctx: TCtx) => Promise<Response>;

  /* ================= Helpers exposed by the barrel ================= */

  // auditEvent: callable + helpers; always returns Promise<void>
  export function auditEvent(
    name: string,
    payload?: Record<string, unknown>,
    ctx?: { req?: Request; userId?: string; sessionId?: string; route?: string; extra?: Record<string, unknown> }
  ): Promise<void>;
  export namespace auditEvent {
    function ok(
      name: string,
      payload?: Record<string, unknown>,
      ctx?: { req?: Request; userId?: string; sessionId?: string; route?: string; extra?: Record<string, unknown> }
    ): Promise<void>;
    function fail(
      name: string,
      reason: string,
      detail?: unknown,
      ctx?: { req?: Request; userId?: string; sessionId?: string; route?: string; extra?: Record<string, unknown> }
    ): Promise<void>;
    function denied(
      name: string,
      payload?: Record<string, unknown>,
      ctx?: { req?: Request; userId?: string; sessionId?: string; route?: string; extra?: Record<string, unknown> }
    ): Promise<void>;
    function rateLimited(
      name: string,
      payload?: Record<string, unknown>,
      ctx?: { req?: Request; userId?: string; sessionId?: string; route?: string; extra?: Record<string, unknown> }
    ): Promise<void>;
  }

  // jsonError factory
  export function jsonError(status: number, code: string, extra?: Record<string, unknown>): Response;

  // idParam: callable AND has a .parse method for convenience.
  //   - idParam(unknown) -> string
  //   - idParam.parse(unknown) -> string
  export interface IdParamFn {
    (value: unknown): string;
    parse(value: unknown): string;
  }
  export const idParam: IdParamFn;

  // rate limit
  export function rateLimit(key: string, limit: number, windowSec: number): Promise<void>;

  export function requireSession(): Promise<
    | { ok: true; session: Session; userId: string }
    | { ok: false; error: Response }
  >;

  export function requireRole(
    role: string | string[],
  ): Promise<
    | { ok: true; session: Session; userId: string }
    | { ok: false; error: Response }
  >;

  // Back-compat namespaces some routes still import (kept loose)
  export const handlers: unknown;
  export const validators: unknown;
}
