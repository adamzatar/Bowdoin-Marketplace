// packages/contracts/src/schemas/upload.ts
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* File metadata                                                       */
/* ------------------------------------------------------------------ */

/** Supported file types for uploads (expandable) */
export const FileTypeEnum = z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export type FileType = z.infer<typeof FileTypeEnum>;

/** Constraints */
export const MAX_FILE_SIZE_MB = 10;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/** File descriptor (client → API) */
export const UploadRequestItemSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: FileTypeEnum,
  size: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
});
export type UploadRequestItem = z.infer<typeof UploadRequestItemSchema>;

/* ------------------------------------------------------------------ */
/* Presign request/response                                            */
/* ------------------------------------------------------------------ */

export const PresignUploadBodySchema = z.object({
  files: z.array(UploadRequestItemSchema).min(1).max(10),
  folder: z.string().min(1).max(100).optional(), // e.g., "listings/123/"
});
export type PresignUploadBody = z.infer<typeof PresignUploadBodySchema>;

/** Individual presigned file response */
export const PresignedFileSchema = z.object({
  fileKey: z.string().min(1), // S3 object key
  uploadUrl: z.string().url(), // signed PUT URL
  cdnUrl: z.string().url(), // public read URL (after upload)
});
export type PresignedFile = z.infer<typeof PresignedFileSchema>;

/** API response for presign endpoint */
export const PresignUploadResponseSchema = z.object({
  files: z.array(PresignedFileSchema),
  expiresInSeconds: z.number().int().positive(), // TTL of presigned URL
});
export type PresignUploadResponse = z.infer<typeof PresignUploadResponseSchema>;

/* ------------------------------------------------------------------ */
/* Delete request/response (optional API feature)                      */
/* ------------------------------------------------------------------ */

export const DeleteFileBodySchema = z.object({
  fileKeys: z.array(z.string().min(1)).min(1).max(10),
});
export type DeleteFileBody = z.infer<typeof DeleteFileBodySchema>;

export const DeleteFileResponseSchema = z.object({
  deleted: z.array(z.string().min(1)),
  failed: z.array(z.string().min(1)).optional(),
});
export type DeleteFileResponse = z.infer<typeof DeleteFileResponseSchema>;