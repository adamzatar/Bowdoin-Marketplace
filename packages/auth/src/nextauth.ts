// packages/auth/src/nextauth.ts

// ───────────────────────── value imports (external) ─────────────────────────
import process from "node:process"; // keep `process` explicit for ESLint in ESM

import { env } from "@bowdoin/config/env";
import { prisma } from "@bowdoin/db";
import { audit } from "@bowdoin/observability/audit";
import { logger } from "@bowdoin/observability/logger";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import NextAuthImport from "next-auth";
// Credentials provider (value import; we’ll normalize below)
import CredentialsImport from "next-auth/providers/credentials";

// ─────────────────────────── value imports (internal) ───────────────────────
import { oktaProvider } from "./okta-provider";
import { emailProvider } from "./providers/email";
import { affiliationRBAC } from "./rbac/affiliation";

// ───────────────────────── type-only imports (keep after values) ────────────
import type { NextAuthOptions, LoggerInstance, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { CredentialsConfig } from "next-auth/providers/credentials";

/* ────────────────────────────── type helpers ───────────────────────────── */

type DevCreds = {
  email: { label: string; type: string; placeholder: string };
  name: { label: string; type: string; placeholder: string };
};

type ProviderItem = NextAuthOptions["providers"][number];
type CredentialsFactory = (config: CredentialsConfig<DevCreds>) => ProviderItem;

/* ─────────────────────────── normalize Credentials ──────────────────────── */

// Pull `.default` when present, otherwise the module value; then cast to factory
const RawCredentials =
  (CredentialsImport as unknown as { default?: unknown }).default ??
  (CredentialsImport as unknown);
const Credentials = RawCredentials as unknown as CredentialsFactory;

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
 * Prefer a runtime flag for enabling the Dev credentials provider.
 * We avoid typing it in @bowdoin/config/env to keep production env strict.
 * Set ENABLE_DEV_LOGIN=true in .env.local to enable.
 */
const DEV_LOGIN_ENABLED =
  (process.env.ENABLE_DEV_LOGIN ?? "").toLowerCase() === "true";

/**
 * Build a strongly-typed NextAuth config:
 * - PrismaAdapter on our shared Prisma client
 * - Audit hooks via @bowdoin/observability/audit
 * - Email + Okta providers (+ optional Dev Credentials)
 * - Optional email-domain allowlist (bypassed for Dev provider only)
 */
export function buildNextAuthOptions(): NextAuthOptions {
  /* ------------------------------ Providers ------------------------------ */
  const providers: NextAuthOptions["providers"] = [
    oktaProvider() as unknown as ProviderItem,
    emailProvider() as unknown as ProviderItem,
  ];

  // Dev Credentials provider (opt-in via ENABLE_DEV_LOGIN)
  if (DEV_LOGIN_ENABLED) {
    providers.push(
      Credentials({
        // TS requires `type` on CredentialsConfig; include it explicitly.
        type: "credentials",
        id: "dev",
        name: "Dev",
        credentials: {
          email: { label: "Email", type: "email", placeholder: "you@anydomain.test" },
          name: { label: "Name", type: "text", placeholder: "Dev User" },
        },
        async authorize(creds) {
          const email = (creds?.email ?? "").trim().toLowerCase();
          const name = (creds?.name ?? "Dev User").toString().trim();

          // Minimal sanity check (dev-only)
          if (!email || !email.includes("@")) return null;

          // Ensure a user exists (Credentials flow has no separate Account row).
          const user = await prisma.user.upsert({
            where: { email },
            update: { name },
            create: { email, name },
          });

          return { id: user.id, email: user.email, name: user.name ?? null };
        },
      }) as ProviderItem
    );
  }

  /* -------------------------------- Adapter ------------------------------ */
  const adapter = PrismaAdapter(prisma);

  /* ------------------------------- Options ------------------------------- */
  const options: NextAuthOptions = {
    adapter,
    providers,

    session: {
      // Prefer DB sessions for server-side revocation/admin
      strategy: "database",
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
      error: "/login",
      verifyRequest: "/verify",
    },

    callbacks: {
      /**
       * Gate sign-in. Dev Credentials (`provider === 'dev'`) bypass allowlist.
       */
      async signIn({ user, account }) {
        if (account?.provider === "dev") return true;

        if (!isDomainAllowed(user?.email ?? null)) {
          logger.warn(
            { userId: user?.id, email: user?.email, reason: "domain_not_allowed" },
            "sign-in denied"
          );
          await audit.emit("auth.sign_in.denied", {
            outcome: "denied",
            severity: "warn",
            meta: { reason: "domain_not_allowed", email: user?.email ?? undefined },
          });
          return false;
        }
        return true;
      },

      /**
       * Enrich JWT (mainly used if strategy: 'jwt'). Keep minimal.
       */
      jwt({ token, user }): AugmentedToken {
        const t = token as AugmentedToken;
        if (user) {
          t.userId = user.id;
          t.email = user.email ?? t.email ?? null;
          // Optionally precompute roles on first sign-in:
          // const dec = affiliationRBAC.computeAffiliation({ email: user.email ?? null, oktaGroups: null });
          // t.roles = dec.roles;
        }
        return t;
      },

      /**
       * Shape the session visible to the client.
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

const NextAuthFn =
  (NextAuthImport as unknown as { default?: typeof NextAuthImport }).default ??
  ((NextAuthImport as unknown) as typeof NextAuthImport);

const handler = NextAuthFn(authOptions);

export const authHandler = handler;
export { handler as GET, handler as POST };