// packages/auth/src/rbac.ts
import { env } from "@bowdoin/config/env";
import { logger } from "@bowdoin/observability/logger";

/**
 * Roles supported in the system. Ordered by privilege (lowest → highest).
 * Keep this aligned with `@bowdoin/contracts` Auth schemas.
 */
export const ROLES = ["community", "student", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Actions and resources used by guards. Keep strings stable (persisted in logs/audit).
 */
export type Resource =
  | "listing"
  | "message"
  | "upload"
  | "admin"
  | "report"
  | "user"
  | "health";

export type Action =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "moderate"
  | "ban"
  | "export";

/**
 * A policy function can make a decision with context (subject/object attributes).
 */
export type Decision = "allow" | "deny";
export type PolicyContext = {
  subjectUserId?: string;
  subjectRoles: Role[];
  resourceOwnerId?: string;
  resourceAudience?: "campus" | "community" | "public";
  isOwner?: boolean;
  // room for rate-limit status, verified emails, etc.
  verifiedEmail?: boolean;
  campusAffiliated?: boolean;
};

export type Policy = (action: Action, resource: Resource, ctx: PolicyContext) => Decision;

/**
 * Role hierarchy helpers
 */
export const roleRank = (r: Role): number => ROLES.indexOf(r);
export const atLeast = (have: Role[], needed: Role): boolean =>
  have.some((r) => roleRank(r) >= roleRank(needed));

export const maxRole = (roles: Role[]): Role =>
  roles.reduce<Role>((acc, r) => (roleRank(r) > roleRank(acc) ? r : acc), "community");

/**
 * Central policy. Keep this small and explicit; avoid scattering checks.
 *
 * Rules (summary):
 * - community: can read public + community listings/messages, create listings/messages, update/delete own, cannot moderate/admin.
 * - student/staff: can access campus-only resources; otherwise similar to community.
 * - admin: can do everything, including moderate/ban/export.
 */
export const can: Policy = (action, resource, ctx) => {
  const isAdmin = atLeast(ctx.subjectRoles, "admin");
  const isStaff = atLeast(ctx.subjectRoles, "staff");
  const isStudent = atLeast(ctx.subjectRoles, "student");
  const isCommunity = !isStudent && !isStaff && !isAdmin;

  if (isAdmin) return "allow";

  switch (resource) {
    case "health": {
      // anyone can read /healthz; no other actions
      return action === "read" ? "allow" : "deny";
    }
    case "listing": {
      if (action === "read") {
        // audience gating
        if (ctx.resourceAudience === "campus") {
          return ctx.campusAffiliated ? "allow" : "deny";
        }
        // "community" or "public"
        return "allow";
      }

      if (action === "create") {
        // allow all registered users (community or campus)
        return ctx.verifiedEmail ? "allow" : "deny";
      }

      if (action === "update" || action === "delete") {
        // owner or staff
        if (ctx.isOwner) return "allow";
        return isStaff ? "allow" : "deny";
      }

      if (action === "moderate") {
        // staff can moderate listings
        return isStaff ? "allow" : "deny";
      }

      return "deny";
    }

    case "message": {
      if (action === "read" || action === "create") {
        // allow registered users to message; campus-only threads still require affiliation
        if (ctx.resourceAudience === "campus") {
          return ctx.campusAffiliated ? "allow" : "deny";
        }
        return ctx.verifiedEmail ? "allow" : "deny";
      }

      if (action === "delete" || action === "update") {
        // participants (owner check supplied by handler) or staff
        if (ctx.isOwner) return "allow";
        return isStaff ? "allow" : "deny";
      }

      if (action === "moderate") {
        return isStaff ? "allow" : "deny";
      }

      return "deny";
    }

    case "upload": {
      // Images/files for listings. Require verified email; campus-only uploads require campus affiliation.
      if (action === "create") {
        if (ctx.resourceAudience === "campus" && !ctx.campusAffiliated) return "deny";
        return ctx.verifiedEmail ? "allow" : "deny";
      }
      if (action === "delete") {
        return ctx.isOwner || isStaff ? "allow" : "deny";
      }
      return "deny";
    }

    case "report": {
      // Users can create reports; staff can read/moderate/export.
      if (action === "create") return ctx.verifiedEmail ? "allow" : "deny";
      if (action === "read" || action === "moderate" || action === "export") {
        return isStaff ? "allow" : "deny";
      }
      return "deny";
    }

    case "user": {
      // read: self or staff; update: self; ban: staff
      if (action === "read") return ctx.isOwner || isStaff ? "allow" : "deny";
      if (action === "update") return ctx.isOwner ? "allow" : "deny";
      if (action === "ban") return isStaff ? "allow" : "deny";
      return "deny";
    }

    case "admin": {
      // non-admin "admin" capabilities gated to staff where applicable (e.g., dashboard read)
      if (action === "read") return isStaff ? "allow" : "deny";
      if (action === "moderate" || action === "export" || action === "ban") {
        return isStaff ? "allow" : "deny";
      }
      return "deny";
    }

    default:
      return "deny";
  }
};

/* ========================================================================== */
/* Okta group → Role mapping                                                  */
/* ========================================================================== */

/**
 * Parse comma-separated group names from env safely.
 */
const parseGroups = (s?: string): string[] =>
  (s ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

/**
 * Group map sourced from environment. Supports multiple group names per role.
 * Example:
 *   OKTA_GROUPS_ADMIN="market-admins"
 *   OKTA_GROUPS_STAFF="market-staff,helpdesk"
 *   OKTA_GROUPS_STUDENT="students"
 */
const GROUPS = {
  admin: parseGroups(process.env.OKTA_GROUPS_ADMIN),
  staff: parseGroups(process.env.OKTA_GROUPS_STAFF),
  student: parseGroups(process.env.OKTA_GROUPS_STUDENT),
};

/**
 * Compute roles from Okta groups. Deduplicates and orders by privilege.
 */
export function mapRolesFromOktaGroups(groups?: string[] | null): Role[] {
  if (!groups || groups.length === 0) return [];
  const norm = new Set(groups.map((g) => g.toLowerCase()));

  const out = new Set<Role>();
  if (GROUPS.admin.some((g) => norm.has(g.toLowerCase()))) out.add("admin");
  if (GROUPS.staff.some((g) => norm.has(g.toLowerCase()))) out.add("staff");
  if (GROUPS.student.some((g) => norm.has(g.toLowerCase()))) out.add("student");

  // Return sorted by rank
  return Array.from(out).sort((a, b) => roleRank(a) - roleRank(b));
}

/* ========================================================================== */
/* Campus vs. Community affiliation helpers                                   */
/* ========================================================================== */

/**
 * Basic campus domain detection. Defaults to bowdoin.edu if env not provided.
 * You may override with CAMPUS_EMAIL_DOMAINS="bowdoin.edu,alumni.bowdoin.edu"
 */
const campusDomains: string[] = (() => {
  const raw = process.env.CAMPUS_EMAIL_DOMAINS ?? "bowdoin.edu";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
})();

export function isCampusEmail(email?: string | null): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const dom = email.slice(at + 1).toLowerCase();
  return campusDomains.includes(dom);
}

/**
 * Derive roles given email + Okta groups.
 * - If Okta groups map to any campus role, return those.
 * - Else, if email is campus domain, default to "student" (configurable via env).
 * - Else, "community".
 */
export function deriveRoles({
  email,
  oktaGroups,
}: {
  email?: string | null;
  oktaGroups?: string[] | null;
}): Role[] {
  const fromGroups = mapRolesFromOktaGroups(oktaGroups);
  if (fromGroups.length > 0) return fromGroups;

  if (isCampusEmail(email)) {
    const defaultCampus = (process.env.DEFAULT_CAMPUS_ROLE ?? "student") as Role;
    if (!ROLES.includes(defaultCampus)) {
      logger.warn({ defaultCampus }, "Invalid DEFAULT_CAMPUS_ROLE; falling back to student");
      return ["student"];
    }
    return [defaultCampus];
  }

  return ["community"];
}

/* ========================================================================== */
/* Convenience guards for route handlers / API                                */
/* ========================================================================== */

/** Throw a 403-like error (without coupling to a specific HTTP layer) */
export class ForbiddenError extends Error {
  status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertCan(action: Action, resource: Resource, ctx: PolicyContext): void {
  const decision = can(action, resource, ctx);
  if (decision === "deny") {
    throw new ForbiddenError(`Denied: ${action} ${resource}`);
  }
}

/** Simple sugar for common checks */
export const guards = {
  canReadListing(ctx: PolicyContext) {
    assertCan("read", "listing", ctx);
  },
  canCreateListing(ctx: PolicyContext) {
    assertCan("create", "listing", ctx);
  },
  canUpdateOwnListing(ctx: PolicyContext) {
    assertCan("update", "listing", { ...ctx, isOwner: true });
  },
  canModerateListings(ctx: PolicyContext) {
    assertCan("moderate", "listing", ctx);
  },
  canUseCampusOnly(ctx: PolicyContext) {
    if (!ctx.campusAffiliated) throw new ForbiddenError("Campus-only feature");
  },
};

/* ========================================================================== */
/* Session/JWT role utilities                                                 */
/* ========================================================================== */

/**
 * Normalize and sort roles for storage in JWT/Session.
 */
export function normalizeRoles(roles: Role[]): Role[] {
  const uniq = Array.from(new Set(roles)).filter((r): r is Role => ROLES.includes(r));
  return uniq.sort((a, b) => roleRank(a) - roleRank(b));
}

/**
 * Merge roles (e.g., from DB + from IdP) with proper precedence.
 */
export function mergeRoles(a: Role[] = [], b: Role[] = []): Role[] {
  return normalizeRoles([...a, ...b]);
}

/**
 * True if any of the user's roles is at least the required role.
 */
export function hasAtLeast(roles: Role[] = [], required: Role): boolean {
  return atLeast(roles, required);
}

/**
 * True if user has a specific role.
 */
export function hasRole(roles: Role[] = [], role: Role): boolean {
  return roles.includes(role);
}

/**
 * Calculates `campusAffiliated` flag used by policies from roles and/or email.
 */
export function isCampusAffiliated(roles: Role[], email?: string | null): boolean {
  return hasAtLeast(roles, "student") || isCampusEmail(email);
}