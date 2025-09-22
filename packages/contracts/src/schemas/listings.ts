// packages/contracts/src/schemas/listings.ts
import { z } from 'zod';

import { AffiliationPolicyNoteSchema } from './affiliation';
import { PublicUserSchema } from './users';

/* ------------------------------------------------------------------ */
/* Enums & shared primitives                                           */
/* ------------------------------------------------------------------ */

export const ListingIdSchema = z.string().uuid();

export const ListingConditionEnum = z.enum(['new', 'like_new', 'good', 'fair', 'poor']);
export type ListingCondition = z.infer<typeof ListingConditionEnum>;

export const ListingStatusEnum = z.enum(['active', 'sold', 'expired', 'removed']);
export type ListingStatus = z.infer<typeof ListingStatusEnum>;

export const AudienceEnum = z.enum(['bowdoin_only', 'community']); // maps to DB enum "Audience"
export type Audience = z.infer<typeof AudienceEnum>;

/** Categories: adjust as needed; aligned with seed/data & UI filter chips */
export const ListingCategoryEnum = z.enum([
  'Appliances',
  'Clothing',
  'Electronics',
  'Furniture',
  'Books',
  'Bikes',
  'Dorm',
  'School',
  'Sports',
  'Tickets',
  'Other',
]);
export type ListingCategory = z.infer<typeof ListingCategoryEnum>;

/** Money representation (internal UI helpers may prefer number; we keep currency explicit) */
export const MoneySchema = z.object({
  amount: z.number().min(0).max(100_000).finite().multipleOf(0.01),
  currency: z.literal('USD'),
});
export type Money = z.infer<typeof MoneySchema>;

/** Image metadata stored alongside listing photos */
export const ListingImageSchema = z.object({
  id: z.string().uuid().optional(), // server-assigned if persisted
  url: z.string().url(),
  alt: z.string().max(200).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  blurDataURL: z.string().max(2_000).optional(), // base64 placeholder (small)
});
export type ListingImage = z.infer<typeof ListingImageSchema>;

/* ------------------------------------------------------------------ */
/* Core Listing shapes                                                 */
/* ------------------------------------------------------------------ */

export const ListingCoreSchema = z.object({
  id: ListingIdSchema,
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(5_000),
  price: MoneySchema.nullable(), // null when isFree=true
  isFree: z.boolean().default(false),
  condition: ListingConditionEnum,
  category: ListingCategoryEnum,
  location: z.string().min(1).max(140),
  availableStart: z.string().date().nullable(),
  availableEnd: z.string().date().nullable(),
  status: ListingStatusEnum,
  audience: AudienceEnum, // who can view/contact
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  images: z.array(ListingImageSchema).max(6),
});
export type ListingCore = z.infer<typeof ListingCoreSchema>;

/** Augments with seller identity (limited public fields) */
export const ListingWithSellerSchema = ListingCoreSchema.extend({
  seller: PublicUserSchema.extend({
    affiliation: AffiliationPolicyNoteSchema, // contains {type: 'bowdoin' | 'community', label, verified?}
  }),
});
export type ListingWithSeller = z.infer<typeof ListingWithSellerSchema>;

/* ------------------------------------------------------------------ */
/* Create / Update DTOs                                                */
/* ------------------------------------------------------------------ */

export const CreateListingBodySchema = z
  .object({
    title: z.string().min(1).max(140),
    description: z.string().min(1).max(5_000),
    /** Either provide price (USD) or set isFree=true */
    price: MoneySchema.optional(),
    isFree: z.boolean().optional().default(false),
    condition: ListingConditionEnum,
    category: ListingCategoryEnum,
    location: z.string().min(1).max(140),
    availableStart: z.string().date().optional().nullable(),
    availableEnd: z.string().date().optional().nullable(),
    audience: AudienceEnum.optional().default('bowdoin_only'),
    images: z.array(ListingImageSchema.pick({ url: true, alt: true })).max(6).optional().default([]),
  })
  .refine(
    (v) => (v.isFree ? !v.price : !!v.price),
    (v) => ({
      path: v.isFree ? ['price'] : ['isFree'],
      message: v.isFree
        ? 'Do not include price when isFree=true.'
        : 'Provide a price or set isFree=true.',
    }),
  )
  .refine(
    (v) =>
      !v.availableStart ||
      !v.availableEnd ||
      new Date(v.availableEnd).getTime() >= new Date(v.availableStart).getTime(),
    { path: ['availableEnd'], message: 'availableEnd must be on/after availableStart' },
  );
export type CreateListingBody = z.infer<typeof CreateListingBodySchema>;

export const CreateListingResponseSchema = ListingWithSellerSchema;
export type CreateListingResponse = z.infer<typeof CreateListingResponseSchema>;

export const UpdateListingBodySchema = z
  .object({
    title: z.string().min(1).max(140).optional(),
    description: z.string().min(1).max(5_000).optional(),
    price: MoneySchema.nullable().optional(),
    isFree: z.boolean().optional(),
    condition: ListingConditionEnum.optional(),
    category: ListingCategoryEnum.optional(),
    location: z.string().min(1).max(140).optional(),
    availableStart: z.string().date().nullable().optional(),
    availableEnd: z.string().date().nullable().optional(),
    audience: AudienceEnum.optional(),
    images: z.array(ListingImageSchema).max(6).optional(),
  })
  .refine(
    (v) => !(v.isFree === true && v.price !== undefined && v.price !== null),
    { path: ['price'], message: 'Do not include price when isFree=true.' },
  )
  .refine(
    (v) =>
      !v.availableStart ||
      !v.availableEnd ||
      new Date(v.availableEnd).getTime() >= new Date(v.availableStart).getTime(),
    { path: ['availableEnd'], message: 'availableEnd must be on/after availableStart' },
  );
export type UpdateListingBody = z.infer<typeof UpdateListingBodySchema>;

export const UpdateListingResponseSchema = ListingWithSellerSchema;
export type UpdateListingResponse = z.infer<typeof UpdateListingResponseSchema>;

// Backwards-compatible aliases (legacy naming)
export const ListingCreateInputZ = CreateListingBodySchema;
export const ListingUpdateInputZ = UpdateListingBodySchema;
export const ListingPublicZ = ListingWithSellerSchema;

/* ------------------------------------------------------------------ */
/* Retrieve / Detail                                                   */
/* ------------------------------------------------------------------ */

export const GetListingParamsSchema = z.object({
  id: ListingIdSchema,
});
export type GetListingParams = z.infer<typeof GetListingParamsSchema>;

export const GetListingResponseSchema = ListingWithSellerSchema.extend({
  /** Optional search highlight snippets when using FTS */
  highlights: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});
export type GetListingResponse = z.infer<typeof GetListingResponseSchema>;

/* ------------------------------------------------------------------ */
/* Search & pagination                                                 */
/* ------------------------------------------------------------------ */

export const ListingSortEnum = z.enum(['newest', 'price_asc', 'price_desc', 'relevance']);
export type ListingSort = z.infer<typeof ListingSortEnum>;

export const SearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(), // Postgres FTS query
  category: ListingCategoryEnum.optional(),
  condition: ListingConditionEnum.optional(),
  minPrice: z.number().min(0).finite().optional(),
  maxPrice: z.number().min(0).finite().optional(),
  isFreeOnly: z.boolean().optional(),
  /** Audience filter: show campus-only or community items */
  audience: AudienceEnum.optional(),
  /** If student wants to avoid non-Bowdoin sellers */
  excludeCommunitySellers: z.boolean().optional().default(false),

  sort: ListingSortEnum.optional().default('relevance'),

  // Pagination: either page/pageSize (offset) or cursor (opaque).
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().optional(), // server-issued opaque token for stable pagination
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchResultItemSchema = ListingWithSellerSchema.pick({
  id: true,
  title: true,
  price: true,
  isFree: true,
  condition: true,
  category: true,
  location: true,
  audience: true,
  createdAt: true,
  updatedAt: true,
  images: true,
  seller: true,
}).extend({
  highlights: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

export const SearchResponseSchema = z.object({
  items: z.array(SearchResultItemSchema),
  total: z.number().int().nonnegative().optional(), // provided when using offset pagination
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  /** Cursor pagination */
  nextCursor: z.string().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/* ------------------------------------------------------------------ */
/* Mutations: status transitions & moderation                          */
/* ------------------------------------------------------------------ */

export const MarkSoldBodySchema = z.object({
  status: z.literal('sold'),
  /** Optional reference to a thread that completed the sale */
  threadId: z.string().uuid().optional(),
});
export type MarkSoldBody = z.infer<typeof MarkSoldBodySchema>;

export const MarkSoldResponseSchema = ListingWithSellerSchema;
export type MarkSoldResponse = z.infer<typeof MarkSoldResponseSchema>;

export const RemoveListingBodySchema = z.object({
  reason: z
    .enum(['user_removed', 'policy_violation', 'duplicate', 'expired'])
    .default('user_removed'),
});
export type RemoveListingBody = z.infer<typeof RemoveListingBodySchema>;

export const RemoveListingResponseSchema = ListingWithSellerSchema;
export type RemoveListingResponse = z.infer<typeof RemoveListingResponseSchema>;

/* ------------------------------------------------------------------ */
/* Admin/reporting                                                     */
/* ------------------------------------------------------------------ */

export const ReportReasonEnum = z.enum([
  'spam',
  'scam',
  'prohibited_item',
  'harassment',
  'miscategorized',
  'other',
]);
export type ReportReason = z.infer<typeof ReportReasonEnum>;

export const CreateReportBodySchema = z.object({
  listingId: ListingIdSchema,
  reason: ReportReasonEnum,
  details: z.string().max(2_000).optional(),
});
export type CreateReportBody = z.infer<typeof CreateReportBodySchema>;

export const CreateReportResponseSchema = z.object({
  reportId: z.string().uuid(),
  status: z.literal('open'),
  createdAt: z.string().datetime(),
});
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;

/* ------------------------------------------------------------------ */
/* Bulk utilities (admin/export)                                       */
/* ------------------------------------------------------------------ */

export const ExportListingsQuerySchema = z.object({
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  status: ListingStatusEnum.optional(),
  audience: AudienceEnum.optional(),
  category: ListingCategoryEnum.optional(),
  includeRemoved: z.boolean().optional().default(false),
});
export type ExportListingsQuery = z.infer<typeof ExportListingsQuerySchema>;

export const ExportListingsRowSchema = ListingCoreSchema.extend({
  sellerEmail: z.string().email(),
  sellerAffiliation: AffiliationPolicyNoteSchema.shape.code, // 'bowdoin' | 'community'
});
export type ExportListingsRow = z.infer<typeof ExportListingsRowSchema>;
