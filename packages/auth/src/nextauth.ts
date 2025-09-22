// packages/auth/src/nextauth.ts

// ───────────────────────── value imports (external) ─────────────────────────
import { env } from "@bowdoin/config/env";
import { prisma } from "@bowdoin/db";
import { audit } from "@bowdoin/observability/audit";
import { logger } from "@bowdoin/observability/logger";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import NextAuthImport from "next-auth";

// ─────────────────────────── value imports (internal) ───────────────────────
import { oktaProvider } from "./okta-provider";
import { emailProvider } from "./providers/email";
import { affiliationRBAC } from "./rbac/affiliation";

// ───────────────────────── type-only imports (keep last) ────────────────────
import type { NextAuthOptions, LoggerInstance, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";

/* ────────────────────────────── helpers ───────────────────────────── */

/** Parse a comma-separated allowlist from env; case-insensitive. */
function allowedDomains(): string[] {
  const raw = env.ALLOWED_EMAIL_DOMAINS ?? "";
  return raw
    .split(",")
    .map((d: string) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isDomainAllowed(email?: string | null): boolean {
  if (!email) return true;
  const allow = allowedDomains();
  if (allow.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return allow.includes(domain);
}

/** Narrowed token surface we extend in callbacks (no `any`). */
type AugmentedToken = JWT & {
  userId?: string;
  email?: string | null;
  roles?: string[];
};

/** Session with optional id/roles under `session.user` (typed safely). */
type AugmentedSession = Session & {
  user?: (Session["user"] & { id?: string; roles?: string[] }) | null;
};

/* ────────────────────────────── main ───────────────────────────── */

/**
 * Build a strongly-typed NextAuth config:
 * - PrismaAdapter on our shared Prisma client
 * - Audit hooks via @bowdoin/observability/audit
 * - Email + Okta providers
 * - Optional email-domain allowlist
 */
export function buildNextAuthOptions(): NextAuthOptions {
  /* ------------------------------ Providers ------------------------------ */
  const providers = [oktaProvider(), emailProvider()];

  /* -------------------------------- Adapter ------------------------------ */
  const adapter = PrismaAdapter(prisma);

  /* ------------------------------- Options ------------------------------- */
  const options: NextAuthOptions = {
    adapter,
    providers,
    // NOTE: your installed next-auth types don't expose `trustHost`; omit it here.

    session: {
      // Prefer DB sessions (revocation/admin); switch to `jwt` if desired.
      strategy: 'database' as const,
      maxAge: 30 * 24 * 60 * 60, // 30 days
      updateAge: 24 * 60 * 60, // re-issue every 24h of activity
    },

    cookies: {
      // Production-grade: secure cookies on HTTPS, lax to allow GET navigations
      sessionToken: {
        name:
          env.NODE_ENV === "production"
            ? "__Host-next-auth.session-token"
            : "next-auth.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: env.NODE_ENV === "production",
        },
      },
    },

    pages: {
      signIn: "/login",
      error: "/login",       // surface auth errors on login page
      verifyRequest: "/verify", // for email provider "check your email"
    },

    callbacks: {
      /**
       * Gate sign-in. Useful for closed betas / coarse RBAC checks.
       */
      async signIn({ user }) {
        if (!isDomainAllowed(user?.email ?? null)) {
          logger.warn(
            { userId: user?.id, email: user?.email, reason: "domain_not_allowed" },
            "sign-in denied",
          );
          await audit.emit("auth.sign_in.denied", {
            outcome: "denied",
            severity: "warn",
            meta: { reason: "domain_not_allowed", email: user?.email },
          });
          return false;
        }
        return true;
      },

      /**
       * Enrich JWT (mainly used if strategy: 'jwt'). Keep minimal.
       * Note: non-async (no await) to satisfy lints.
       */
      jwt({ token, user }): AugmentedToken {
        const t = token as AugmentedToken;
        if (user) {
          t.userId = user.id;
          t.email = user.email ?? t.email ?? null;
          // If you want a roles snapshot on first sign-in, derive here:
          // const dec = affiliationRBAC.computeAffiliation({ email: user.email ?? null, oktaGroups: null });
          // t.roles = dec.roles;
        }
        return t;
      },

      /**
       * Shape the session visible to the client.
       * Note: non-async (no await) to satisfy lints.
       */
      session({ session, token, user }): AugmentedSession {
        const s = session as AugmentedSession;
        const t = token as AugmentedToken;

        const userId: string | undefined =
          (user as User | undefined)?.id ?? t.userId ?? undefined;

        const roles: string[] =
          ((user as unknown as { roles?: string[] })?.roles as string[] | undefined) ??
          (t.roles ??
            affiliationRBAC.computeAffiliation({
              email: (user?.email ?? t.email ?? null) as string | null,
              oktaGroups: null,
            }).roles);

        if (s.user) {
          if (userId) s.user.id = userId;
          s.user.email = s.user.email ?? user?.email ?? t.email ?? null;
          (s.user as { roles?: string[] }).roles = roles;
        }

        return s;
      },
    },

    events: {
      async signIn(message) {
        try {
          await audit.emit("auth.sign_in", {
            outcome: "success",
            meta: {
              userId: message.user.id,
              email: message.user.email ?? undefined,
              provider: message.account?.provider ?? "unknown",
            },
          });
        } catch (err) {
          logger.warn({ err }, "audit signIn failed (continuing)");
        }
      },
      async signOut(message) {
        try {
          const userId = message.token?.sub ?? undefined;
          await audit.emit("auth.sign_out", {
            outcome: "success",
            meta: { userId },
          });
        } catch (err) {
          logger.warn({ err }, "audit signOut failed (continuing)");
        }
      },
      async createUser(message) {
        try {
          await audit.emit("user.created", {
            outcome: "success",
            meta: { userId: message.user.id, email: message.user.email ?? undefined },
          });
        } catch (err) {
          logger.warn({ err }, "audit createUser failed (continuing)");
        }
      },
      async linkAccount(message) {
        try {
          await audit.emit("auth.account_linked", {
            outcome: "success",
            meta: {
              userId: message.user.id,
              provider: message.account.provider,
              providerAccountId: message.account.providerAccountId,
            },
          });
        } catch (err) {
          logger.warn({ err }, "audit linkAccount failed (continuing)");
        }
      },
    },

    // Strong secret; already validated by @bowdoin/config
    secret: env.NEXTAUTH_SECRET,

    // Route NextAuth logs to pino (typed as LoggerInstance)
    logger: {
      error(code, /** @deprecated */ ...meta) {
        logger.error({ code, meta }, "next-auth error");
      },
      warn(code) {
        logger.warn({ code }, "next-auth warn");
      },
      debug(code, /** @deprecated */ ...meta) {
        if (env.NODE_ENV !== "production") {
          logger.debug({ code, meta }, "next-auth debug");
        }
      },
    } satisfies LoggerInstance,
  };

  return options;
}

/** Ready-to-use export for consumers. */
export const authOptions: NextAuthOptions = buildNextAuthOptions();

const NextAuthFn = (NextAuthImport as unknown as { default?: typeof NextAuthImport }).default ??
  (NextAuthImport as unknown as typeof NextAuthImport);

const handler = NextAuthFn(authOptions);

export const authHandler = handler;
export { handler as GET, handler as POST };
