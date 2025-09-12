// packages/contracts/src/schemas/auth.ts
import { z } from 'zod';

import { AffiliationEnum } from './affiliation';

/**
 * RBAC roles mapped from Okta groups and internal flags.
 * - admin: full platform control
 * - staff: IT/moderation capabilities
 * - student: Bowdoin-authenticated students
 * - community: verified Brunswick-area residents (non-Bowdoin)
 */
export const RoleEnum = z.enum(['admin', 'staff', 'student', 'community'], {
  required_error: 'role is required',
  invalid_type_error: 'role must be a valid role string',
});
export type Role = z.infer<typeof RoleEnum>;

/**
 * Supported auth providers in this app.
 * (Okta for Bowdoin SSO, Email-link for community verification.)
 */
export const AuthProviderEnum = z.enum(['okta', 'email']);
export type AuthProvider = z.infer<typeof AuthProviderEnum>;

/** Narrow URL string (for avatars, etc.) */
const UrlString = z.string().url();

/** ISO timestamp string */
const IsoDateTime = z.string().datetime({ offset: true });

/**
 * Core user identity persisted/displayed across the app.
 * Mirrors NextAuth with additional fields (role, affiliation).
 */
export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).optional(),
  image: UrlString.optional(),
  role: RoleEnum,
  affiliation: AffiliationEnum, // e.g., 'bowdoin' | 'brunswick' | 'pending'
  emailVerified: IsoDateTime.optional(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/**
 * Session user payload (kept minimal for cookies/JWT sessions).
 * Matches what the client typically needs.
 */
export const SessionUserSchema = AuthUserSchema.pick({
  id: true,
  email: true,
  name: true,
  image: true,
  role: true,
  affiliation: true,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/** NextAuth-like session shape augmented with role/affiliation. */
export const SessionSchema = z.object({
  user: SessionUserSchema,
  expires: IsoDateTime, // RFC3339
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * JWT payload used in NextAuth callbacks / API authorization.
 * Numbers for iat/exp per JWT spec.
 */
export const JWTPayloadSchema = z.object({
  sub: z.string().uuid().optional(), // NextAuth may omit during init
  email: z.string().email().optional(),
  name: z.string().optional(),
  picture: UrlString.optional(),
  role: RoleEnum.optional(),
  affiliation: AffiliationEnum.optional(),
  provider: AuthProviderEnum.optional(),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
  iss: z.string().optional(),
  aud: z.string().optional(),
  jti: z.string().optional(),
});
export type JWTPayload = z.infer<typeof JWTPayloadSchema>;

/** Common “auth status” probe used by `/api/users/me` or guards. */
export const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  user: SessionUserSchema.optional(),
  role: RoleEnum.optional(),
  affiliation: AffiliationEnum.optional(),
  requiresEmailVerification: z.boolean().optional(), // for community users mid-flow
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

/** CSRF token response (for forms or non-idempotent actions when needed). */
export const CsrfTokenResponseSchema = z.object({
  csrfToken: z.string().min(16),
});
export type CsrfTokenResponse = z.infer<typeof CsrfTokenResponseSchema>;

/**
 * Community email verification (request a magic link).
 * Applies rate limiting server-side.
 */
export const EmailVerificationRequestSchema = z.object({
  email: z.string().email(),
});
export type EmailVerificationRequest = z.infer<typeof EmailVerificationRequestSchema>;

/**
 * Community email verification (confirm click-through with token).
 * Token length lower bound accommodates typical 32–48+ char tokens.
 */
export const EmailVerificationConfirmSchema = z.object({
  email: z.string().email(),
  token: z.string().min(32),
});
export type EmailVerificationConfirm = z.infer<typeof EmailVerificationConfirmSchema>;

/**
 * Generic auth error envelope (non-throw typed result for API handlers).
 */
export const AuthErrorSchema = z.object({
  error: z.literal('AUTH_ERROR'),
  message: z.string(),
  code: z
    .enum([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'CSRF_INVALID',
      'TOKEN_INVALID',
      'TOKEN_EXPIRED',
      'RATE_LIMITED',
      'PROVIDER_MISMATCH',
    ])
    .optional(),
});
export type AuthError = z.infer<typeof AuthErrorSchema>;

/** Success envelope to standardize API responses. */
export const AuthOkSchema = z.object({
  ok: z.literal(true),
});
export type AuthOk = z.infer<typeof AuthOkSchema>;