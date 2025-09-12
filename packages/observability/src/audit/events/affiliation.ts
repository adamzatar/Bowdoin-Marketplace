// packages/observability/src/audit/events/affiliation.ts
/**
 * @module @bowdoin/observability/audit
 * High-level typed audit emitters for user affiliation lifecycle.
 *
 * These wrap `emit` from ../../audit with strongly-typed params
 * so feature code does not need to construct raw events.
 */

import { emit, AuditAction } from '../../audit';

import type { AuditActor, AuditRequestContext, Realm } from '../../audit';

export interface AffiliationAuditParams {
  /** User ID (UUID/ULID) whose affiliation is changing. */
  userId: string;
  /** Actor performing the action (admin, system, or self). */
  actor?: AuditActor;
  /** Request correlation context. */
  req?: AuditRequestContext;
  /** From which realm the user is transitioning (optional). */
  from?: Realm;
  /** To which realm the user is transitioning (optional). */
  to?: Realm;
  /** Optional justification / rejection reason. */
  reason?: string;
}

/** User requested affiliation change (pending verification). */
export async function emitAffiliationRequested(params: AffiliationAuditParams) {
  return emit(AuditAction.USER_AFFILIATION_REQUESTED, {
    outcome: 'success',
    ...(params.actor ? { actor: params.actor } : {}),
    target: { type: 'user', id: params.userId },
    meta: {
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
    },
    ...(params.req ? { req: params.req } : {}),
  });
}

/** Admin/system verified user affiliation. */
export async function emitAffiliationVerified(params: AffiliationAuditParams) {
  return emit(AuditAction.USER_AFFILIATION_VERIFIED, {
    outcome: 'success',
    ...(params.actor ? { actor: params.actor } : {}),
    target: { type: 'user', id: params.userId },
    meta: {
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
    },
    ...(params.req ? { req: params.req } : {}),
  });
}

/** Admin/system rejected user affiliation request. */
export async function emitAffiliationRejected(params: AffiliationAuditParams) {
  return emit(AuditAction.USER_AFFILIATION_REJECTED, {
    outcome: 'failure',
    ...(params.actor ? { actor: params.actor } : {}),
    target: { type: 'user', id: params.userId },
    meta: {
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
    ...(params.req ? { req: params.req } : {}),
  });
}
