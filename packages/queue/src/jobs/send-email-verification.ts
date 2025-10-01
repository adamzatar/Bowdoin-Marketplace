// packages/queue/src/jobs/send-email-verification.ts
/**
 * Email verification job contracts & helpers.
 *
 * This module is intentionally side-effect free. It only:
 *  - declares the stable job name used by producers/workers,
 *  - validates & normalizes payloads with Zod,
 *  - offers small helpers to build verification links and job descriptors.
 *
 * The worker that actually sends emails will live under:
 *   packages/queue/src/workers/emailVerificationWorker.ts  (to be implemented)
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/** Single authoritative name for this job (keep stable for dashboards). */
export const EmailJobNames = {
  SEND_VERIFICATION: 'email.sendVerification',
} as const;
export type EmailVerificationJobName = (typeof EmailJobNames)['SEND_VERIFICATION'];

/** Supported verification templates (plain or MJML/HTML handled by @bowdoin/email). */
export const VerificationTemplates = ['community-verify'] as const;
export type VerificationTemplate = (typeof VerificationTemplates)[number];

/** Realms/affiliations help us tune wording (e.g., caution banner for non-Bowdoin). */
export const VerificationRealm = ['bowdoin', 'brunswick'] as const;
export type VerificationRealm = (typeof VerificationRealm)[number];

/** Minimal metadata we capture for audit/abuse analysis. */
const RequestMetaSchema = z
  .object({
    ip: z.string().ip({ version: 'v4' }).or(z.string().ip({ version: 'v6' })).optional(),
    userAgent: z.string().max(768).optional(),
    requestId: z.string().max(128).optional(),
  })
  .strict();

/** Payload schema for sending an email verification link/code. */
export const SendEmailVerificationPayloadSchema = z
  .object({
    /** Recipient email address. */
    email: z.string().email(),
    /** Optional name for greeting lines. */
    displayName: z.string().min(1).max(128).optional(),
    /** User id if already provisioned (UUID). */
    userId: z.string().uuid().optional(),

    /** Verification token (opaque, pre-stored by auth flow). */
    token: z.string().min(24).max(256),
    /** Absolute URL where the user completes verification; must contain the token param. */
    verificationUrl: z.string().url(),
    /** When the token expires (ms since epoch). */
    tokenExpiresAt: z.number().int().positive(),

    /** Which copy/template to use. */
    template: z.enum(VerificationTemplates).default('community-verify'),
    /** i18n locale tag (BCP-47). */
    locale: z.string().min(2).max(16).default('en'),

    /** Realm/affiliation informs copy & badges in the email. */
    realm: z.enum(VerificationRealm).default('brunswick'),

    /** Optional idempotency key (dedupe at the queue/worker layer). */
    idempotencyKey: z.string().max(128).optional(),

    /** Extra headers/observability data. */
    meta: RequestMetaSchema.optional(),

    /** Flag to note this was a re-send (affects copy/rate-limits in worker). */
    isResend: z.boolean().default(false),
  })
  .strict();

export type SendEmailVerificationPayload = z.infer<typeof SendEmailVerificationPayloadSchema>;

/**
 * Helper to build a verification URL with standard query params.
 * Producer can pass a base app URL and we’ll append route + token + optional redirect.
 */
export function buildVerificationLink(params: {
  appBaseUrl: string; // e.g., https://market.bowdoin.edu
  token: string;
  realm?: VerificationRealm;
  redirectTo?: string; // optional post-verify redirect path or absolute URL
}): string {
  const url = new URL('/auth/verify', params.appBaseUrl.replace(/\/+$/, ''));
  url.searchParams.set('token', params.token);
  if (params.realm) url.searchParams.set('realm', params.realm);
  if (params.redirectTo) url.searchParams.set('redirectTo', params.redirectTo);
  return url.toString();
}

/**
 * Convenience: create a normalized, validated payload ready for enqueue.
 * You supply high-level inputs; we fill defaults and ensure it’s valid.
 */
export function buildSendEmailVerificationPayload(input: {
  email: string;
  token: string;
  tokenTTLms: number; // how long the token is valid from "now"
  appBaseUrl: string;
  realm?: VerificationRealm;
  displayName?: string;
  userId?: string;
  redirectTo?: string;
  locale?: string;
  template?: VerificationTemplate;
  isResend?: boolean;
  meta?: { ip?: string; userAgent?: string; requestId?: string };
  idempotencyKey?: string;
}): SendEmailVerificationPayload {
  const now = Date.now();
  const verificationUrl = buildVerificationLink({
    appBaseUrl: input.appBaseUrl,
    token: input.token,
    ...(input.realm ? { realm: input.realm } : {}),
    ...(input.redirectTo ? { redirectTo: input.redirectTo } : {}),
  });

  return SendEmailVerificationPayloadSchema.parse({
    email: input.email,
    displayName: input.displayName,
    userId: input.userId,
    token: input.token,
    verificationUrl,
    tokenExpiresAt: now + Math.max(30_000, input.tokenTTLms), // min 30s guard
    template: input.template ?? 'community-verify',
    locale: input.locale ?? 'en',
    realm: input.realm ?? 'brunswick',
    idempotencyKey: input.idempotencyKey ?? `email-verify:${input.token}`,
    meta: input.meta,
    isResend: input.isResend ?? false,
  });
}

/**
 * Factory for a BullMQ-compatible job descriptor.
 * Typical usage:
 *   const payload = buildSendEmailVerificationPayload({...});
 *   const job = createSendEmailVerificationJob(payload);
 *   await queue.add(job.name, job.data, job.opts);
 */
export function createSendEmailVerificationJob(
  payload: SendEmailVerificationPayload,
  opts?: {
    priority?: number; // 1 highest, default 2 (interactive)
    delayMs?: number;
    jobId?: string;
    attempts?: number;
  },
) {
  const jobId = opts?.jobId ?? payload.idempotencyKey ?? randomUUID();

  return {
    name: EmailJobNames.SEND_VERIFICATION,
    data: payload,
    opts: {
      jobId,
      priority: opts?.priority ?? 2,
      delay: opts?.delayMs ?? 0,
      attempts: opts?.attempts ?? 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 60 * 60, count: 1000 },
      removeOnFail: { age: 24 * 60 * 60, count: 1000 },
    } as const,
  };
}

/** Re-exports for consumers */
export type { SendEmailVerificationPayload as EmailVerificationPayload };
