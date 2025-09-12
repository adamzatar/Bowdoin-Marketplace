// packages/contracts/src/schemas/users.ts
import { z } from 'zod';

import { AffiliationEnum } from './affiliation';
import { RoleEnum } from './auth';

/**
 * Common primitives
 */
export const Uuid = z.string().uuid();
export const IsoDateTime = z.string().datetime({ offset: true });
export const UrlString = z.string().url();

/**
 * Profile fields visible to the owner/admins, partially visible to others.
 * We keep PII minimal and explicit.
 */
export const ProfileVisibilityEnum = z.enum(['private', 'campus', 'public']);
export type ProfileVisibility = z.infer<typeof ProfileVisibilityEnum>;

export const UserBadgeEnum = z.enum([
  'staff',
  'admin',
  'verified-student',
  'verified-community',
  'top-seller',
  'early-adopter',
]);
export type UserBadge = z.infer<typeof UserBadgeEnum>;

/**
 * User preferences for messaging & audience.
 */
export const MessagePrefsSchema = z.object({
  emailNotifications: z.boolean().default(true),
  inAppNotifications: z.boolean().default(true),
});
export type MessagePrefs = z.infer<typeof MessagePrefsSchema>;

export const AudiencePreferenceSchema = z.object({
  /** Allow DMs from: anyone, campus-only, none */
  messagesFrom: z.enum(['any', 'campus', 'none']).default('any'),
  /** Default listing audience */
  defaultListingAudience: z.enum(['campus', 'public']).default('campus'),
});
export type AudiencePreference = z.infer<typeof AudiencePreferenceSchema>;

/**
 * Public-facing user shape (safe for exposure in listings/messages UIs).
 * We intentionally omit email & PII by default.
 */
export const PublicUserSchema = z.object({
  id: Uuid,
  name: z.string().min(1).optional(),
  image: UrlString.optional(),
  role: RoleEnum,
  affiliation: AffiliationEnum,
  badges: z.array(UserBadgeEnum).default([]),
  // Helpful flags for UX (e.g., show caution for non-campus)
  isCampusVerified: z.boolean().default(false),
  isCommunityVerified: z.boolean().default(false),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

/**
 * Owner/admin view (more fields available to the user themselves and admins).
 */
export const PrivateUserSchema = PublicUserSchema.extend({
  email: z.string().email(),
  emailVerified: IsoDateTime.nullish(),
  visibility: ProfileVisibilityEnum.default('campus'),
  messagePrefs: MessagePrefsSchema,
  audiencePrefs: AudiencePreferenceSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PrivateUser = z.infer<typeof PrivateUserSchema>;

/**
 * "Me" endpoint response
 */
export const MeResponseSchema = z.object({
  user: PrivateUserSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * Profile update payload (owner-driven).
 * We keep it narrow and validated.
 */
export const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  image: UrlString.optional(),
  visibility: ProfileVisibilityEnum.optional(),
  messagePrefs: MessagePrefsSchema.partial().optional(),
  audiencePrefs: AudiencePreferenceSchema.partial().optional(),
});
export type UpdateProfile = z.infer<typeof UpdateProfileSchema>;

export const UpdateProfileResponseSchema = z.object({
  user: PrivateUserSchema,
});
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponseSchema>;

/**
 * Affiliation update / verification flows.
 * - campus (Bowdoin SSO) is authoritative from IdP
 * - community (Brunswick) uses email verification flow
 */
export const UpdateAffiliationRequestSchema = z.object({
  affiliation: AffiliationEnum, // typically "brunswick" -> moves to pending until verified
});
export type UpdateAffiliationRequest = z.infer<typeof UpdateAffiliationRequestSchema>;

export const UpdateAffiliationResponseSchema = z.object({
  user: PrivateUserSchema,
  // if community => may require verification email step
  requiresEmailVerification: z.boolean().default(false),
});
export type UpdateAffiliationResponse = z.infer<typeof UpdateAffiliationResponseSchema>;

/**
 * Lightweight list item for admin tables.
 */
export const AdminUserListItemSchema = z.object({
  id: Uuid,
  email: z.string().email(),
  name: z.string().nullish(),
  role: RoleEnum,
  affiliation: AffiliationEnum,
  badges: z.array(UserBadgeEnum),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AdminUserListItem = z.infer<typeof AdminUserListItemSchema>;

/**
 * Cursor pagination (opaque cursor recommended; also support time-based).
 */
export const Cursor = z.string().min(1);
export const PaginatedRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: Cursor.optional(),
  q: z.string().trim().max(120).optional(), // search by name/email (admin)
  affiliation: AffiliationEnum.optional(),
  role: RoleEnum.optional(),
});
export type PaginatedRequest = z.infer<typeof PaginatedRequestSchema>;

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: Cursor.nullish(),
    total: z.number().int().nonnegative().optional(), // optional to avoid heavy counts
  });

export const AdminUsersListResponseSchema = PaginatedResponseSchema(AdminUserListItemSchema);
export type AdminUsersListResponse = z.infer<typeof AdminUsersListResponseSchema>;

/**
 * Admin actions: update role/affiliation, ban/unban.
 */
export const AdminUpdateUserRequestSchema = z.object({
  role: RoleEnum.optional(),
  affiliation: AffiliationEnum.optional(),
  badges: z.array(UserBadgeEnum).optional(),
  banned: z.boolean().optional(),
});
export type AdminUpdateUserRequest = z.infer<typeof AdminUpdateUserRequestSchema>;

export const AdminUpdateUserResponseSchema = z.object({
  user: AdminUserListItemSchema,
});
export type AdminUpdateUserResponse = z.infer<typeof AdminUpdateUserResponseSchema>;

/**
 * Minimal shapes commonly re-used by other schemas (e.g., Listings)
 */
export const SellerSummarySchema = PublicUserSchema.pick({
  id: true,
  name: true,
  image: true,
  role: true,
  affiliation: true,
  badges: true,
}).extend({
  // single boolean for UI to decide if a caution banner should show
  showCommunityCaution: z.boolean().default(false),
});
export type SellerSummary = z.infer<typeof SellerSummarySchema>;