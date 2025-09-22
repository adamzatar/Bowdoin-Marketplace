// packages/auth/src/okta-provider.ts
import { Buffer } from 'node:buffer';
import process from 'node:process';

import { env } from '@bowdoin/config/env';
import OktaProviderImport from 'next-auth/providers/okta';

import type { TokenSet } from 'next-auth';

/**
 * Local role + affiliation types align with our contracts.
 * (Roles are RBAC; affiliation is used to badge users as college or community.)
 */
export type Role = 'admin' | 'staff' | 'student';
export type Affiliation = 'college' | 'community';

/**
 * Resolve Okta group names from env (comma-separated) into arrays.
 * Allows ops to change mapping without code changes.
 */
function parseGroupList(v?: string | null): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const GROUPS = {
  admin: parseGroupList(process.env.OKTA_GROUPS_ADMIN),
  staff: parseGroupList(process.env.OKTA_GROUPS_STAFF),
  student: parseGroupList(process.env.OKTA_GROUPS_STUDENT),
};

const getAllowedEmailDomains = (): string[] =>
  (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

const emailMatchesAllowlist = (email?: string | null): boolean => {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return getAllowedEmailDomains().includes(domain);
};

/**
 * Base64URL decode helper with explicit typing.
 */
function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 2 ? '==' : input.length % 4 === 3 ? '=' : '';
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/**
 * Extract groups from the id_token (if present) or the Okta profile payload.
 * This does NOT validate the JWT signature; NextAuth/Okta already handle that for auth.
 */
function extractGroups(tokens?: TokenSet | null, profile?: unknown): string[] {
  const idt = tokens?.id_token;
  if (idt) {
    const parts = idt.split('.');
    const payloadB64 = parts.length >= 2 ? parts[1] : null;
    if (payloadB64) {
      try {
        const decoded = JSON.parse(base64UrlDecode(payloadB64)) as unknown;
        if (decoded && typeof decoded === 'object') {
          const record = decoded as Record<string, unknown>;
          const claim = record['groups'] ?? record['okta:groups'] ?? record['roles'];
          if (Array.isArray(claim)) return claim.map((value) => String(value));
        }
      } catch {
        // ignore malformed payloads; fall back to profile
      }
    }
  }

  if (profile && typeof profile === 'object') {
    const record = profile as Record<string, unknown>;
    const arr = (record.groups ?? record.roles) as unknown;
    if (Array.isArray(arr)) return arr.map((value) => String(value));
  }

  return [];
}

/**
 * Given a list of Okta groups, determine the highest-privilege role.
 * Order: admin > staff > student. Falls back to "student" if email domain matches
 * the allowlist, otherwise no role (handled by RBAC later).
 */
export function mapOktaGroupsToRole(groups: readonly string[], email?: string | null): Role | undefined {
  const set = new Set(groups.map((g) => g.toLowerCase()));
  const hasAny = (expected: string[]) => expected.some((g) => set.has(g.toLowerCase()));

  if (GROUPS.admin.length && hasAny(GROUPS.admin)) return 'admin';
  if (GROUPS.staff.length && hasAny(GROUPS.staff)) return 'staff';
  if (GROUPS.student.length && hasAny(GROUPS.student)) return 'student';

  if (emailMatchesAllowlist(email)) return 'student';

  return undefined;
}

/**
 * Infer "college" vs "community" affiliation.
 * If email ends with an allowed domain, mark as college; otherwise community.
 */
export function inferAffiliation(email?: string | null): Affiliation {
  return emailMatchesAllowlist(email) ? 'college' : 'community';
}

const OktaProvider = (OktaProviderImport as unknown as { default?: typeof OktaProviderImport }).default ??
  (OktaProviderImport as unknown as typeof OktaProviderImport);

export function oktaProvider(): ReturnType<typeof OktaProvider> {
  if (!env.OKTA_ISSUER || !env.OKTA_CLIENT_ID || !env.OKTA_CLIENT_SECRET) {
    throw new Error('Missing Okta config. Ensure OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET are set.');
  }

  return OktaProvider({
    issuer: env.OKTA_ISSUER,
    clientId: env.OKTA_CLIENT_ID,
    clientSecret: env.OKTA_CLIENT_SECRET,
    authorization: { params: { scope: 'openid profile email groups' } },
    profile(profile, tokens) {
      const record = profile && typeof profile === 'object' ? (profile as Record<string, unknown>) : {};
      const pick = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null);

      const email = pick('email');
      // Decode groups for downstream callbacks (result intentionally ignored here)
      extractGroups(tokens, profile);

      return {
        id: pick('sub') ?? pick('uid') ?? pick('id') ?? '',
        name:
          pick('name') ??
          [pick('given_name'), pick('family_name')]
            .filter((value): value is string => Boolean(value))
            .join(' '),
        email: email ?? '',
        image: pick('picture'),
      } satisfies Record<string, unknown>;
    },
  });
}

/**
 * Convenience re-export with a conventional name.
 * import { okta } from '@bowdoin/auth/src/okta-provider'
 */
export const okta = oktaProvider;
