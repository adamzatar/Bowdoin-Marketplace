// packages/auth/src/okta-provider.ts
import { env } from "@bowdoin/config/env";
import Okta from "next-auth/providers/okta";

import type { TokenSet } from "next-auth";
import type { OAuthConfig } from "next-auth/providers";
import type { Profile as OktaProfile } from "next-auth/providers/okta";

/**
 * Local role + affiliation types align with our contracts.
 * (Roles are RBAC; affiliation is used to badge users as college or community.)
 */
export type Role = "admin" | "staff" | "student";
export type Affiliation = "college" | "community";

/**
 * Resolve Okta group names from env (comma-separated) into arrays.
 * Allows ops to change mapping without code changes.
 */
function parseGroupList(v?: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const GROUPS = {
  admin: parseGroupList(process.env.OKTA_GROUPS_ADMIN),
  staff: parseGroupList(process.env.OKTA_GROUPS_STAFF),
  student: parseGroupList(process.env.OKTA_GROUPS_STUDENT),
};

/**
 * Given a list of Okta groups, determine the highest-privilege role.
 * Order: admin > staff > student. Falls back to "student" if email domain matches
 * the college domain, otherwise no role (handled by RBAC later).
 */
export function mapOktaGroupsToRole(groups: readonly string[], email?: string | null): Role | undefined {
  // Normalize for case-insensitive compare
  const set = new Set(groups.map((g) => g.toLowerCase()));

  const hasAny = (expected: string[]) =>
    expected.some((g) => set.has(g.toLowerCase()));

  if (GROUPS.admin.length && hasAny(GROUPS.admin)) return "admin";
  if (GROUPS.staff.length && hasAny(GROUPS.staff)) return "staff";
  if (GROUPS.student.length && hasAny(GROUPS.student)) return "student";

  // Heuristic: if email matches college domain, assume student by default.
  if (email && env.COLLEGE_EMAIL_DOMAIN && email.toLowerCase().endsWith(`@${env.COLLEGE_EMAIL_DOMAIN}`)) {
    return "student";
  }

  return undefined;
}

/**
 * Infer "college" vs "community" affiliation.
 * If email ends with the college domain, mark as college; otherwise community.
 */
export function inferAffiliation(email?: string | null): Affiliation {
  if (email && env.COLLEGE_EMAIL_DOMAIN && email.toLowerCase().endsWith(`@${env.COLLEGE_EMAIL_DOMAIN}`)) {
    return "college";
  }
  return "community";
}

/**
 * Extract groups from the id_token (if present) or the Okta profile payload.
 * This does NOT validate the JWT signature; NextAuth/Okta already handle that for auth.
 * We only decode to read the "groups" claim for RBAC mapping.
 */
function extractGroups(tokens?: TokenSet | null, profile?: Partial<OktaProfile> | null): string[] {
  // 1) Try id_token "groups" claim
  const idt = tokens?.id_token;
  if (idt && idt.split(".").length >= 2) {
    try {
      const payloadB64 = idt.split(".")[1]!;
      const json = JSON.parse(base64UrlDecode(payloadB64)) as Record<string, unknown>;
      const claim =
        (json["groups"] as unknown) ||
        (json["okta:groups"] as unknown) ||
        (json["roles"] as unknown);
      if (Array.isArray(claim)) {
        return claim.map(String);
      }
    } catch {
      // swallow decode errors; we’ll fall back to profile
    }
  }

  // 2) Try profile JSON
  const fromProfile =
    ((profile as any)?.groups as unknown) ||
    ((profile as any)?.roles as unknown);
  if (Array.isArray(fromProfile)) {
    return fromProfile.map(String);
  }

  return [];
}

/** Base64URL decode helper */
function base64UrlDecode(b64url: string): string {
  const pad = (s: string) => s + "===".slice((s.length + 3) % 4);
  const normalized = pad(b64url).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

/**
 * Factory that returns a configured Okta OAuth provider for NextAuth.
 * Scope includes "groups" so Okta authorization server must be configured to
 * add the groups claim to id_token/userinfo.
 */
export function oktaProvider(): OAuthConfig<OktaProfile> {
  if (!env.OKTA_ISSUER || !env.OKTA_CLIENT_ID || !env.OKTA_CLIENT_SECRET) {
    throw new Error(
      "Missing Okta config. Ensure OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET are set."
    );
  }

  return Okta({
    issuer: env.OKTA_ISSUER,
    clientId: env.OKTA_CLIENT_ID,
    clientSecret: env.OKTA_CLIENT_SECRET,
    // Request groups so we can do RBAC mapping.
    authorization: { params: { scope: "openid profile email groups" } },
    profile(profile, tokens) {
      const groups = extractGroups(tokens, profile);
      const email = profile.email ?? null;

      const role = mapOktaGroupsToRole(groups, email);
      const affiliation = inferAffiliation(email);

      // NextAuth requires these base fields; extra fields will be available in
      // callbacks (jwt/session) to merge onto the token/session.
      return {
        id: (profile as any).sub ?? (profile as any).uid ?? (profile as any).id ?? "",
        name:
          profile.name ||
          [profile.given_name, profile.family_name].filter(Boolean).join(" ") ||
          "",
        email: email ?? "",
        image: (profile as any).picture ?? null,

        // Custom claims we’ll propagate in callbacks
        role,
        affiliation,
        groups,
        emailVerified:
          typeof (profile as any).email_verified === "boolean"
            ? (profile as any).email_verified
            : undefined,
      } as any;
    },
  });
}

/**
 * Convenience re-export with a conventional name.
 * import { okta } from '@bowdoin/auth/src/okta-provider'
 */
export const okta = oktaProvider;