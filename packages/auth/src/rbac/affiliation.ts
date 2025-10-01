// packages/auth/src/rbac/affiliation.ts

import { emitAffiliationChange } from "@bowdoin/observability/audit";
import { logger } from "@bowdoin/observability/logger";

import {
  deriveRoles,
  hasAtLeast,
  isCampusEmail,
  maxRole,
  normalizeRoles,
} from "../rbac";

import type { Role } from "../rbac";
import type { Realm } from "@bowdoin/observability/audit";

/** Canonical affiliation kinds used across the stack (DB, contracts, audit). */
export type AffiliationKind = "campus" | "community";

/** Result of computing affiliation from identity signals. */
export interface AffiliationDecision {
  /** Sorted, deduped roles used for the decision (if any). */
  roles: Role[];
  /** True if affiliated with campus (student/staff/admin or campus email). */
  campusAffiliated: boolean;
  /** "campus" or "community" — friendly label for logs / audit. */
  kind: AffiliationKind;
  /** Primary basis of the decision. */
  method: "role" | "email" | "none";
  /** Human-readable reason (stable string for audit). */
  reason:
    | "role_at_least_student"
    | "role_staff_or_admin"
    | "email_domain_match"
    | "no_signal";
  /** Extra details useful for debugging. */
  details?: Record<string, unknown>;
}

/** Inputs used to determine affiliation. */
export interface AffiliationSignals {
  /** Email address from the identity provider (Okta) or user record. */
  email?: string | null;
  /** Okta groups (raw) for this subject, if available. */
  oktaGroups?: string[] | null;
}

/**
 * Compute affiliation from roles and email. Roles are first derived using our
 * standard mapping (Okta groups → roles, then domain fallback).
 *
 * Precedence:
 *   1) Roles (student/staff/admin ⇒ campusAffiliated)
 *   2) Campus email domain ⇒ campusAffiliated
 *   3) Otherwise community
 */
export function computeAffiliation(signals: AffiliationSignals): AffiliationDecision {
  // Satisfy exactOptionalPropertyTypes by normalizing possibly-undefined fields.
  const email = signals.email ?? null;
  const oktaGroups = signals.oktaGroups ?? null;

  const roles = normalizeRoles(deriveRoles({ email, oktaGroups }));
  const isStaffOrAdmin = hasAtLeast(roles, "staff");
  const isStudentPlus = hasAtLeast(roles, "student");

  if (isStaffOrAdmin) {
    return {
      roles,
      campusAffiliated: true,
      kind: "campus",
      method: "role",
      reason: "role_staff_or_admin",
      details: { maxRole: maxRole(roles) },
    };
  }

  if (isStudentPlus) {
    return {
      roles,
      campusAffiliated: true,
      kind: "campus",
      method: "role",
      reason: "role_at_least_student",
      details: { maxRole: maxRole(roles) },
    };
  }

  if (isCampusEmail(email)) {
    return {
      roles,
      campusAffiliated: true,
      kind: "campus",
      method: "email",
      reason: "email_domain_match",
      details: { emailDomain: email?.split("@").pop() },
    };
  }

  return {
    roles,
    campusAffiliated: false,
    kind: "community",
    method: "none",
    reason: "no_signal",
  };
}

/** Simple diff helper to detect affiliation change. */
export function diffAffiliation(
  prevAffiliated: boolean | null | undefined,
  nextAffiliated: boolean
): { changed: boolean; from: AffiliationKind; to: AffiliationKind } {
  const from: AffiliationKind = prevAffiliated ? "campus" : "community";
  const to: AffiliationKind = nextAffiliated ? "campus" : "community";
  return { changed: from !== to, from, to };
}

/**
 * Reconcile and persist affiliation changes.
 *
 * You pass a `persist` callback that updates your user record (e.g., Prisma).
 * If a change is detected, we call `persist(next)` and emit a typed audit event.
 */
export async function reconcileAffiliation(opts: {
  userId: string;
  currentAffiliated?: boolean | null; // from DB/session
  signals: AffiliationSignals;
  /** Called only when an actual change is detected. */
  persist?: (nextAffiliated: boolean) => Promise<void> | void;
  /** Optional additional audit metadata (IP, agent, actor, etc.). */
  auditMeta?: Record<string, unknown>;
}): Promise<AffiliationDecision & { changed: boolean }> {
  const { userId, currentAffiliated, signals, persist, auditMeta: _auditMeta } = opts;

  const decision = computeAffiliation(signals);
  const { changed, from, to } = diffAffiliation(
    currentAffiliated ?? null,
    decision.campusAffiliated
  );

  if (!changed) {
    logger.debug(
      { userId, from, to, reason: decision.reason, method: decision.method },
      "Affiliation unchanged"
    );
    return { ...decision, changed: false };
  }

  try {
    if (persist) {
      await persist(decision.campusAffiliated);
    }
  } catch (err) {
    logger.error(
      { err, userId, desired: decision.campusAffiliated, method: decision.method },
      "Failed to persist affiliation change"
    );
    // Surface the failure so callers can decide to retry / fail the request
    throw err;
  }


  // emit event (cast AffiliationKind -> Realm to satisfy the audit type)
  await emitAffiliationChange({
    userId,
    from: from as Realm,
    to: to as Realm,
    // keep these two – they exist on your params type
    reason: decision.reason,
    // method was previously removed in earlier patch if your type doesn't include it;
    // if your AffiliationAuditParams doesn't have `method`, delete the next line.
    // method: decision.method,
    // ❌ details was causing TS2353 — do not pass it
    // details: { ...(decision.details ?? {}), ...(auditMeta ?? {}) },
  });

  logger.info(
    {
      userId,
      from,
      to,
      method: decision.method,
      reason: decision.reason,
      roles: decision.roles,
    },
    "Affiliation updated"
  );

  return { ...decision, changed: true };
}

/**
 * Convenience boolean that mirrors `computeAffiliation(signals).campusAffiliated`.
 * Handy in guards or request decorators.
 */
export function isAffiliated(signals: AffiliationSignals): boolean {
  return computeAffiliation(signals).campusAffiliated;
}

/** Namespaced convenience exports for callers who prefer an object API. */
export const affiliationRBAC = {
  computeAffiliation,
  reconcileAffiliation,
  isAffiliated,
  diffAffiliation,
};
