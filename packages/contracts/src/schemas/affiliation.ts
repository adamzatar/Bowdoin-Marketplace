// packages/contracts/src/schemas/affiliation.ts
import { z } from 'zod';

/**
 * Canonical affiliation buckets for the marketplace.
 * - "bowdoin": authenticated via campus SSO (Okta), treated as campus-trusted
 * - "brunswick": community member verified by email domain (or manual admin)
 * - "unknown": default for newly-created records that haven't established trust yet
 */
export const AffiliationEnum = z.enum(['bowdoin', 'brunswick', 'unknown']);
export type Affiliation = z.infer<typeof AffiliationEnum>;

/**
 * Community verification lifecycle for non-SSO users.
 */
export const CommunityVerificationStatusEnum = z.enum([
  'unverified', // never requested or token expired
  'pending', // token issued, awaiting confirm
  'verified', // domain/email verified
]);
export type CommunityVerificationStatus = z.infer<typeof CommunityVerificationStatusEnum>;

/**
 * Flags distilled for UI & policy checks.
 * These are derived server-side from authoritative fields (SSO claims, timestamps).
 */
export const AffiliationFlagsSchema = z.object({
  isCampus: z.boolean().default(false),
  isCommunity: z.boolean().default(false),
  campusVerified: z.boolean().default(false),
  communityVerified: z.boolean().default(false),
  /** If true, the UI should display the community caution banner on risky surfaces. */
  requiresCaution: z.boolean().default(false),
});
export type AffiliationFlags = z.infer<typeof AffiliationFlagsSchema>;

/**
 * Policy hint string that can be rendered near badges/banners.
 * (Optional; localized in-app—this is primarily a typed container.)
 */
export const AffiliationPolicyNoteSchema = z.object({
  code: z
    .enum([
      'campus-trusted',
      'community-caution',
      'unverified-caution',
      'admin-override',
    ])
    .default('community-caution'),
  message: z.string().min(1).max(500).optional(),
});
export type AffiliationPolicyNote = z.infer<typeof AffiliationPolicyNoteSchema>;

/**
 * Start community (Brunswick) email verification.
 * - email: the address to verify (often non-bowdoin domain)
 * - locale: optional BCP-47 tag for templating
 */
export const CommunityVerificationStartRequestSchema = z.object({
  email: z.string().email(),
  locale: z.string().min(2).max(35).optional(),
});
export type CommunityVerificationStartRequest = z.infer<
  typeof CommunityVerificationStartRequestSchema
>;

export const CommunityVerificationStartResponseSchema = z.object({
  sent: z.boolean(),
  /** Cooldown seconds until next request allowed (rate-limit UX) */
  cooldownSeconds: z.number().int().nonnegative().optional(),
  status: CommunityVerificationStatusEnum.default('pending'),
});
export type CommunityVerificationStartResponse = z.infer<
  typeof CommunityVerificationStartResponseSchema
>;

/**
 * Confirm community verification with a single-use token.
 */
export const CommunityVerificationConfirmRequestSchema = z.object({
  token: z.string().min(24).max(512),
});
export type CommunityVerificationConfirmRequest = z.infer<
  typeof CommunityVerificationConfirmRequestSchema
>;

export const IsoDateTime = z.string().datetime({ offset: true });

export const CommunityVerificationConfirmResponseSchema = z.object({
  verified: z.boolean(),
  affiliation: AffiliationEnum, // typically returns "brunswick" on success
  communityVerifiedAt: IsoDateTime.optional(),
});
export type CommunityVerificationConfirmResponse = z.infer<
  typeof CommunityVerificationConfirmResponseSchema
>;

/**
 * Admin: force-set affiliation (e.g., exceptional cases).
 */
export const AdminSetAffiliationRequestSchema = z.object({
  userId: z.string().uuid(),
  affiliation: AffiliationEnum,
  /** Optional note for audit trail. */
  reason: z.string().trim().max(500).optional(),
});
export type AdminSetAffiliationRequest = z.infer<
  typeof AdminSetAffiliationRequestSchema
>;

export const AdminSetAffiliationResponseSchema = z.object({
  userId: z.string().uuid(),
  affiliation: AffiliationEnum,
});
export type AdminSetAffiliationResponse = z.infer<
  typeof AdminSetAffiliationResponseSchema
>;

/**
 * Audit event payload shapes (emitted via @bowdoin/observability).
 */
export const AffiliationAuditBase = z.object({
  actorUserId: z.string().uuid().nullable(), // null if system
  targetUserId: z.string().uuid(),
  ip: z.string().ip({ version: 'v4' }).or(z.string().ip({ version: 'v6' })).optional(),
  userAgent: z.string().max(512).optional(),
  at: IsoDateTime,
});

export const AuditAffiliationChangedSchema = AffiliationAuditBase.extend({
  event: z.literal('affiliation.changed'),
  from: AffiliationEnum,
  to: AffiliationEnum,
  reason: z.string().max(500).optional(),
});
export type AuditAffiliationChanged = z.infer<typeof AuditAffiliationChangedSchema>;

export const AuditCommunityVerificationRequestedSchema = AffiliationAuditBase.extend({
  event: z.literal('community.verification_requested'),
  emailHash: z.string().min(16).max(128), // store hash only, never raw email in audit
});
export type AuditCommunityVerificationRequested = z.infer<
  typeof AuditCommunityVerificationRequestedSchema
>;

export const AuditCommunityVerificationSucceededSchema = AffiliationAuditBase.extend({
  event: z.literal('community.verification_succeeded'),
  emailHash: z.string().min(16).max(128),
});
export type AuditCommunityVerificationSucceeded = z.infer<
  typeof AuditCommunityVerificationSucceededSchema
>;