// apps/web/src/server/validators.ts
//
// Centralized (zod) validators and helpers for parsing params, query strings,
// and JSON bodies in App Router route handlers. Keep these small, composable,
// and re-usable across endpoints.

import { z, ZodError, type ZodTypeAny, type ZodIssue } from 'zod';

/* ─────────────────────────── Common field schemas ─────────────────────────── */

export const UUID = z.string().uuid({ message: 'must be a valid uuid' });

export const Email = z.string().email({ message: 'must be a valid email' }).max(254);

export const NonEmpty = z.string().trim().min(1, 'required');

export const ISODateString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'invalid date' });

/** Price in cents, non-negative integer, fits PostgreSQL int4. */
export const PriceCents = z.number().int().min(0).max(2_147_483_647);

/** Boolean-ish query values like "true"/"1"/"false"/"0". */
export const Booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    // default: leave string; downstream schema can refine if needed
    return v as unknown as boolean;
  })
  .pipe(z.boolean());

/* ───────────────────────────── Route param guards ─────────────────────────── */

export const idParam = z.object({
  id: z.string().min(1),
});
export const threadIdParam = z.object({ id: UUID });

/* ────────────────────────────── Pagination/query ──────────────────────────── */

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).nullish(),
});

/** Simple free-text search query with optional audience filter. */
export const searchQuery = z.object({
  q: z.string().trim().max(256).default(''),
  audience: z.enum(['public', 'community']).default('public').optional(),
  // allows combining with paginationQuery via .merge()
});

/* ─────────────────────────── Endpoint-specific inputs ───────────────────────
   Note: If you already defined canonical schemas in @bowdoin/contracts,
   prefer importing those here to avoid drift. These are safe, minimal fallbacks.
------------------------------------------------------------------------------- */

/** Listings: create & update payloads */
export const createListingInput = z.object({
  title: NonEmpty.max(120),
  description: NonEmpty.max(4000),
  priceCents: z.coerce.number().int().min(0).max(2_147_483_647),
  category: NonEmpty.max(64),
  images: z.array(NonEmpty.url().or(NonEmpty)).max(12).default([]),
  audience: z.enum(['public', 'community']).default('public'),
});

export const updateListingInput = createListingInput
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, { message: 'empty update' });

/** Messages: thread creation + message send */
export const createThreadInput = z.object({
  recipientId: UUID,
  listingId: UUID.optional(),
  firstMessage: NonEmpty.max(4000),
});

export const createMessageInput = z.object({
  body: NonEmpty.max(4000),
});

/** Upload: S3 presign */
export const presignUploadInput = z.object({
  filename: NonEmpty.max(255),
  contentType: NonEmpty.max(128),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(30 * 1024 * 1024)
    .optional(), // up to 30MB by default
});

/** Users: affiliation verify flow */
export const affiliationRequestInput = z.object({
  method: z.enum(['edu_email']).default('edu_email'),
  eduEmail: Email,
});

export const affiliationConfirmInput = z.object({
  token: NonEmpty.max(256),
});

/** Admin actions */
export const adminBanUserInput = z.object({
  reason: NonEmpty.max(500).optional(),
});
export const adminRemoveListingInput = z.object({
  reason: NonEmpty.max(500).optional(),
});

/* ────────────────────────────── Parse helpers ─────────────────────────────── */

/**
 * Parse URLSearchParams into a typed object using a zod schema.
 * Example:
 *   const q = parseQuery(new URL(req.url), paginationQuery.merge(searchQuery))
 */
export function parseQuery<T extends ZodTypeAny>(url: URL, schema: T): z.infer<T> {
  // Convert multi-value params to string or array consistently
  const params = Object.fromEntries(url.searchParams.entries());
  try {
    return schema.parse(params);
  } catch (err) {
    throw httpZodError(400, 'invalid_query', err);
  }
}

/**
 * Parse JSON body using a zod schema, with robust error shaping.
 * Adds a small safeguard for non-JSON content types.
 */
export async function parseJSON<T extends ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw httpError(415, 'unsupported_media_type', [
      { path: [], message: 'expected application/json', code: 'custom' },
    ]);
  }
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw httpError(400, 'invalid_json', [
      { path: [], message: 'body must be valid JSON', code: 'custom' },
    ]);
  }
  try {
    return schema.parse(data);
  } catch (err) {
    throw httpZodError(422, 'invalid_body', err);
  }
}

/* ───────────────────────────── HTTP error helpers ─────────────────────────── */

type Issue = Pick<ZodIssue, 'path' | 'message' | 'code'>;
type Problem = {
  error: string;
  issues?: Issue[];
};

export function httpError(status: number, message: string, issues?: Issue[]): Response {
  return new Response(JSON.stringify(<Problem>{ error: message, issues }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function httpZodError(status: number, message: string, err: unknown): Response {
  if (err instanceof ZodError) {
    const issues: Issue[] = err.issues.map((i) => ({
      path: i.path,
      message: i.message,
      code: i.code,
    }));
    return httpError(status, message, issues);
  }
  return httpError(status, message);
}

/**
 * Convenience: run a zod schema against an arbitrary object and, on failure,
 * throw an HTTP 422 Response with shaped issues.
 */
export function mustParse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (err) {
    throw httpZodError(422, 'validation_failed', err);
  }
}
