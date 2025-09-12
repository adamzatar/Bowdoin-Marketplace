// packages/observability/src/audit/events/index.ts
/**
 * @module @bowdoin/observability/audit/events
 * High-level typed audit emitters for user affiliation lifecycle.
 */

import { emit, AuditAction } from '../../audit';

import type { AuditActor, AuditRequestContext, Realm } from '../../audit';

export interface AffiliationAuditParams {
  userId: string;                  // target user id (UUID/ULID)
  actor?: AuditActor;              // who performed the action
  req?: AuditRequestContext;       // request correlation context
  from?: Realm;                    // previous realm (optional)
  to?: Realm;                      // next realm (optional)
  reason?: string;                 // justification / rejection reason
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