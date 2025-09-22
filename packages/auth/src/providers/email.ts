// packages/auth/src/providers/email.ts

import process from "node:process";


import { env } from "@bowdoin/config/env";
import { sendVerificationEmail } from "@bowdoin/email/sendVerificationEmail";
import { audit } from "@bowdoin/observability/audit";
import { logger } from "@bowdoin/observability/logger";
import EmailProviderImport, { type EmailConfig } from "next-auth/providers/email";

/**
 * Email sign-in (magic link) provider
 *
 * - Uses our SES/SMTP abstraction to send the email.
 * - Leaves token persistence to the NextAuth adapter (Prisma).
 * - Adds basic telemetry + audit hooks.
 */
const EmailProvider = (EmailProviderImport as unknown as { default?: typeof EmailProviderImport }).default ??
  (EmailProviderImport as unknown as typeof EmailProviderImport);

export function emailProvider(): EmailConfig {
  if (!env.EMAIL_FROM) {
    throw new Error("EMAIL_FROM is required for EmailProvider.");
  }

  // NextAuth uses NEXTAUTH_URL to build callback URLs. Ensure it exists early.
  if (!process.env.NEXTAUTH_URL) {
    logger.warn(
      { hint: "Set NEXTAUTH_URL to your public origin, e.g. https://market.example.com" },
      "NEXTAUTH_URL is not set; email links may be malformed.",
    );
  }

  // Some env bundles may not define APP_NAME in the typed object; derive safely.
  const brandName =
    (typeof (env as Record<string, unknown>).APP_NAME === "string"
      ? ((env as Record<string, unknown>).APP_NAME as string)
      : undefined) ?? "Marketplace";

  return EmailProvider({
    from: env.EMAIL_FROM,
    maxAge: 60 * 60 * 24, // 24h magic link expiration

    /**
     * Custom mailer – called after the adapter creates a VerificationToken.
     * `url` is the magic link the user will click.
     */
    async sendVerificationRequest(params) {
      const { identifier, url, provider, theme: _theme } = params;

      // Defensive checks & observability
      logger.info(
        {
          provider: "email",
          identifier,
          urlHost: safeURLHost(url),
          listId: provider.server ? getListId(provider.server) : undefined,
        },
        "Sending email sign-in link",
      );

      try {
        const parsedUrl = new URL(url);
        const token = parsedUrl.searchParams.get('token');
        if (!token) {
          throw new Error('NextAuth verification URL missing token parameter');
        }

        const payload: Parameters<typeof sendVerificationEmail>[0] = {
          to: identifier,
          token,
          verifyBaseUrl: `${parsedUrl.origin}${parsedUrl.pathname}`,
          brandName,
        };

        const redirect = parsedUrl.searchParams.get('redirect');
        if (redirect) payload.redirectPath = redirect;

        const affiliation = parsedUrl.searchParams.get('affiliation');
        if (affiliation) payload.affiliation = affiliation;

        await sendVerificationEmail(payload);

        await audit.emit("auth.email.magiclink.sent", {
          meta: {
            identifier,
            urlHost: safeURLHost(url),
          },
        });
      } catch (err) {
        logger.error(
          { err, identifier, provider: "email" },
          "Failed to send verification email",
        );
        throw err;
      }
    },

    /**
     * Optional: normalize the identifier (email). Helps avoid duplicate users
     * due to case differences or dots in Gmail addresses.
     */
    normalizeIdentifier(identifier: string): string {
      const email = identifier.trim().toLowerCase();

      // Treat Gmail-style dots as equivalent (optional; org decision).
      const [local, domain] = email.split("@");
      if (!local || !domain) return email;

      if (domain === "gmail.com" || domain === "googlemail.com") {
        // Remove dots from the local part for Gmail
        const normalizedLocal = local.replace(/\./g, "");
        return `${normalizedLocal}@${domain}`;
      }

      return email;
    },
  });
}

/* ----------------------------- helpers ------------------------------ */

function safeURLHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort extraction for SMTP List-Id style routing metadata (for logs).
 * `provider.server` may be a string, a URL, a transport object, etc.
 */
function getListId(server: unknown): string | undefined {
  if (!server || typeof server === "string") return undefined;
  if (typeof server !== "object") return undefined;

  const maybeHeaders = (server as { headers?: unknown }).headers;
  if (!maybeHeaders || typeof maybeHeaders !== "object") return undefined;

  const headers = maybeHeaders as Record<string, unknown>;
  const lid = headers["List-Id"] ?? headers["list-id"];
  return typeof lid === "string" ? lid : undefined;
}

/* -------------------------------------------------------------------- */
/**
 * Re-export with a convenient alias to mirror the Okta provider pattern.
 * import { email } from '@bowdoin/auth/src/providers/email'
 */
export const email = emailProvider;
