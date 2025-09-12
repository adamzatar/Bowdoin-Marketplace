// packages/contracts/src/schemas/admin.ts
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Common primitives                                                   */
/* ------------------------------------------------------------------ */

export const UUID = z.string().uuid();
export const ISODate = z
  .string()
  .datetime({ offset: true })
  .or(z.date().transform((d) => d.toISOString()))
  .describe('ISO-8601 timestamp');

/** Basic page/query primitives (duplicated here to avoid cross-schema cycles) */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const PageMetaSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

/* ------------------------------------------------------------------ */
/* Moderation: Reports                                                 */
/* ------------------------------------------------------------------ */

export const ReportReasonEnum = z.enum([
  'spam',
  'prohibited',
  'harassment',
  'scam',
  'copyright',
  'misinformation',
  'duplicate',
  'other',
]);
export type ReportReason = z.infer<typeof ReportReasonEnum>;

export const ReportStatusEnum = z.enum(['open', 'reviewed', 'actioned', 'dismissed']);
export type ReportStatus = z.infer<typeof ReportStatusEnum>;

export const ModerationActionEnum = z.enum(['none', 'removed', 'banned', 'warning']);
export type ModerationAction = z.infer<typeof ModerationActionEnum>;

export const ReportSchema = z.object({
  id: UUID,
  reportedListingId: UUID.nullable().optional(),
  reportedUserId: UUID.nullable().optional(),
  reporterId: UUID,
  reason: ReportReasonEnum,
  details: z.string().max(2000).optional(),
  status: ReportStatusEnum,
  createdAt: ISODate,
  updatedAt: ISODate,
  resolution: z
    .object({
      action: ModerationActionEnum,
      note: z.string().max(2000).optional(),
      actorId: UUID,
      at: ISODate,
    })
    .optional(),
});
export type Report = z.infer<typeof ReportSchema>;

/** GET /api/admin/reports query */
export const ListReportsQuerySchema = PageQuerySchema.extend({
  status: ReportStatusEnum.optional(),
  reason: ReportReasonEnum.optional(),
  listingId: UUID.optional(),
  userId: UUID.optional(),
  sort: z
    .enum(['createdAt:desc', 'createdAt:asc', 'status:asc', 'status:desc'])
    .default('createdAt:desc')
    .optional(),
});
export type ListReportsQuery = z.infer<typeof ListReportsQuerySchema>;

export const ListReportsResponseSchema = z.object({
  items: z.array(ReportSchema),
  meta: PageMetaSchema,
});
export type ListReportsResponse = z.infer<typeof ListReportsResponseSchema>;

/** POST /api/admin/reports — update a report’s status/resolution */
export const UpdateReportBodySchema = z.object({
  id: UUID,
  status: ReportStatusEnum,
  resolution: z
    .object({
      action: ModerationActionEnum.default('none'),
      note: z.string().max(2000).optional(),
    })
    .optional(),
});
export type UpdateReportBody = z.infer<typeof UpdateReportBodySchema>;

export const UpdateReportResponseSchema = z.object({
  report: ReportSchema,
});
export type UpdateReportResponse = z.infer<typeof UpdateReportResponseSchema>;

/* ------------------------------------------------------------------ */
/* Admin Actions: Listings                                             */
/* ------------------------------------------------------------------ */

/** POST /api/admin/listings/:id/remove */
export const RemoveListingBodySchema = z.object({
  reason: z
    .enum(['prohibited', 'duplicate', 'copyright', 'scam', 'other'])
  ,
  note: z.string().max(2000).optional(),
});
export type RemoveListingBody = z.infer<typeof RemoveListingBodySchema>;

export const RemoveListingResponseSchema = z.object({
  listingId: UUID,
  previousStatus: z.enum(['active', 'sold', 'expired', 'removed']).nullable(),
  newStatus: z.literal('removed'),
  action: z.literal('removed'),
});
export type RemoveListingResponse = z.infer<typeof RemoveListingResponseSchema>;

/* ------------------------------------------------------------------ */
/* Admin Actions: Users                                                */
/* ------------------------------------------------------------------ */

/** POST /api/admin/users/:id/ban */
export const BanReasonEnum = z.enum([
  'harassment',
  'scam',
  'policy_violation',
  'spam',
  'other',
]);
export type BanReason = z.infer<typeof BanReasonEnum>;

export const BanUserBodySchema = z.object({
  reason: BanReasonEnum,
  note: z.string().max(2000).optional(),
  /** Either provide an absolute timestamp or a duration (days). If neither is provided, ban is indefinite. */
  until: ISODate.optional(),
  durationDays: z.number().int().positive().max(3650).optional(),
});
export type BanUserBody = z.infer<typeof BanUserBodySchema>;

export const BanUserResponseSchema = z.object({
  userId: UUID,
  banned: z.boolean(),
  bannedUntil: ISODate.nullable(),
});
export type BanUserResponse = z.infer<typeof BanUserResponseSchema>;

/* ------------------------------------------------------------------ */
/* RBAC summary (for contract consumers & docs)                        */
/* ------------------------------------------------------------------ */

/**
 * Admin-only endpoints:
 * - GET    /api/admin/reports
 * - POST   /api/admin/reports             (update report status/resolution)
 * - POST   /api/admin/listings/:id/remove
 * - POST   /api/admin/users/:id/ban
 *
 * Staff may be allowed read-only to /api/admin/reports depending on RBAC policy.
 * Frontend should check 403/401 responses and show appropriate UI.
 */