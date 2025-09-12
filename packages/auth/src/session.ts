// packages/auth/src/session.ts
import type { JWT } from "next-auth/jwt";
import type { DefaultSession } from "next-auth";
import type { NextAuthOptions } from "next-auth";
import { computeAffiliation, type AffiliationSignals, type AffiliationKind } from "./rbac/affiliation";
import {
  type Role,
  deriveRoles,
  hasAtLeast,
  maxRole,
  normalizeRoles,
} from "./rbac";
import { logger } from "@bowdoin/observability/logger";

/**
 * What we add to `session.user`.
 * Keep this stable because API clients (web/app) depend on it.
 */
export interface SessionUser extends DefaultSession["user"] {
  id: string;
  roles: Role[];
  /** "campus" vs "community" based on roles/email. */
  affiliation: {
    kind: AffiliationKind;
    campusAffiliated: boolean;
    reason: string;
  };
  /** Optional default audience used when creating listings/messages. */
  audience?: AffiliationKind;
}

/**
 * Session object we emit to the app.
 */
export interface AppSession extends Omit<DefaultSession, "user"> {
  user: SessionUser;
}

/**
 * JWT claims we persist during the NextAuth flow.
 * NOTE: Do not put secrets here — JWT is readable by the client.
 */
export interface AppJWT extends JWT {
  uid?: string;
  roles?: Role[];
  aff?: AffiliationKind;
  affReason?: string;
  /** raw groups forwarded from the provider if available */
  oktaGroups?: string[];
}

/**
 * Select a safe default audience based on affiliation and an optional request.
 * - If user is community, force "community".
 * - If user is campus, allow requested audience or default to "campus".
 */
export function selectDefaultAudience(
  affiliation: AffiliationKind,
  requested?: AffiliationKind | null
): AffiliationKind {
  if (affiliation === "community") return "community";
  return requested ?? "campus";
}

/**
 * Role helpers for guards in routes / UI.
 */
export function sessionHasAtLeast(session: AppSession | null | undefined, role: Role): boolean {
  if (!session?.user?.roles) return false;
  return hasAtLeast(session.user.roles, role);
}

export function sessionMaxRole(session: AppSession | null | undefined): Role | null {
  if (!session?.user?.roles?.length) return null;
  return maxRole(session.user.roles);
}

/**
 * Build standardized NextAuth callbacks (jwt + session) that:
 *  - derive roles from provider signals (groups, email)
 *  - compute affiliation (campus/community)
 *  - project stable fields into the session
 *
 * You can supply an optional `additionalSignals` builder to merge
 * provider-specific signals (e.g., Okta groups) into affiliation computation.
 */
export function buildAuthCallbacks(opts?: {
  additionalSignals?: (args: {
    token: AppJWT;
    user?: { id?: string | null; email?: string | null };
    account?: { provider?: string | null };
    profile?: unknown;
  }) => Partial<AffiliationSignals> | Promise<Partial<AffiliationSignals>>;
  audienceSelector?: (
    affiliation: AffiliationKind,
    ctx: { token: AppJWT; userId: string }
  ) => AffiliationKind | Promise<AffiliationKind>;
}): NextAuthOptions["callbacks"] {
  const additionalSignals = opts?.additionalSignals;
  const audienceSelector = opts?.audienceSelector;

  return {
    /**
     * Runs on sign-in and on subsequent requests.
     * We compute roles/affiliation once and keep them in the JWT.
     */
    async jwt({ token, user, account, profile }) {
      const appToken = token as AppJWT;

      // Determine a stable user id
      if (user && "id" in user && user.id) {
        appToken.uid = String(user.id);
      } else if (!appToken.uid && token.sub) {
        appToken.uid = token.sub;
      }

      // Initial computation (on sign in or if missing)
      const shouldRefresh =
        !appToken.roles ||
        !appToken.aff ||
        (account && account.provider); // re-run when a new provider is linked

      if (shouldRefresh) {
        const email = (user?.email ?? token.email ?? null) || null;

        // Provider/host specific signals
        let extra: Partial<AffiliationSignals> = {};
        if (additionalSignals) {
          try {
            extra = (await additionalSignals({
              token: appToken,
              user: { id: appToken.uid ?? null, email },
              account,
              profile,
            })) || {};
          } catch (err) {
            logger.warn({ err }, "additionalSignals failed; continuing with base signals");
          }
        }

        // Derive roles (Okta groups + email domain fallback)
        const roles = normalizeRoles(deriveRoles({ oktaGroups: appToken.oktaGroups ?? null, email }));

        // Compute affiliation
        const decision = computeAffiliation({
          email,
          oktaGroups: appToken.oktaGroups ?? null,
          ...extra,
        });

        appToken.roles = roles;
        appToken.aff = decision.kind;
        appToken.affReason = decision.reason;

        logger.debug(
          {
            uid: appToken.uid,
            roles,
            affiliation: decision.kind,
            method: decision.method,
            reason: decision.reason,
          },
          "JWT enriched with roles and affiliation"
        );
      }

      return appToken;
    },

    /**
     * Projects JWT → Session visible to the client.
     */
    async session({ session, token }) {
      const appToken = token as AppJWT;
      const s = session as AppSession;

      const roles = appToken.roles ?? [];
      const aff: AffiliationKind = appToken.aff ?? "community";
      const audience =
        (await (opts?.audienceSelector?.(aff, { token: appToken, userId: appToken.uid ?? "unknown" }))) ??
        selectDefaultAudience(aff);

      s.user = {
        id: appToken.uid ?? "unknown",
        name: session.user?.name ?? token.name ?? null,
        email: session.user?.email ?? token.email ?? null,
        image: (session.user?.image ?? (token as JWT).picture ?? null) || undefined,
        roles,
        affiliation: {
          kind: aff,
          campusAffiliated: aff === "campus",
          reason: appToken.affReason ?? "no_signal",
        },
        audience,
      };

      // Expose useful top-level fields (optional)
      (s as any).roles = roles;
      (s as any).affiliation = aff;
      (s as any).audience = audience;

      return s;
    },
  };
}

/**
 * Narrow a generic Session-like object to AppSession safely.
 * Useful when you’re consuming session in libraries or APIs.
 */
export function asAppSession(session: DefaultSession | null | undefined): AppSession | null {
  if (!session || !session.user) return null;
  const s = session as AppSession;
  // Minimal structural validation
  if (!("roles" in s.user) || !Array.isArray(s.user.roles)) return null;
  if (!("affiliation" in s.user)) return null;
  return s;
}

/**
 * Example runtime check: require at least a role AND campus affiliation.
 * Throwing is handy for API route guards; return boolean for UI conditionals.
 */
export function assertCampusWithRole(session: AppSession | null | undefined, role: Role) {
  if (!session) {
    throw Object.assign(new Error("Unauthenticated"), { code: "UNAUTHENTICATED" });
  }
  if (session.user.affiliation.kind !== "campus") {
    throw Object.assign(new Error("Campus affiliation required"), { code: "FORBIDDEN" });
  }
  if (!sessionHasAtLeast(session, role)) {
    throw Object.assign(new Error(`Requires role ≥ ${role}`), { code: "FORBIDDEN" });
  }
}

/**
 * Tiny helper to surface a compact public snapshot (for client dehydration).
 */
export function publicSessionSnapshot(s: AppSession | null | undefined) {
  if (!s) return null;
  const { id, name, image, roles, affiliation, audience } = s.user;
  return { id, name, image, roles, affiliation, audience };
}