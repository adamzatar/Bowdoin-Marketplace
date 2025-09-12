// packages/config/src/env.ts
import 'dotenv/config';
import { z } from 'zod';

/**
 * Helpers to coerce common "bool-ish" env inputs.
 * Accepts: true/false, "true"/"false", "1"/"0", "yes"/"no" (case-insensitive).
 */
const BoolishOptional = z.preprocess(
  (v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'n'].includes(s)) return false;
    }
    return v;
  },
  z.boolean().optional()
);

/**
 * Centralized runtime environment schema validation.
 * Ensures all required environment variables are present and typed correctly.
 *
 * NOTE: Many email-related keys are optional here so packages can reference them
 * without forcing you to set everything in every environment. Sensible fallbacks
 * are handled by the email/auth packages where appropriate.
 */
const EnvSchema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().optional(),
  APP_NAME: z.string().optional(),

  // Database
  DATABASE_URL: z.string().url(),

  // Auth (Okta / NextAuth.js)
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(32),
  OKTA_CLIENT_ID: z.string(),
  OKTA_CLIENT_SECRET: z.string(),
  OKTA_ISSUER: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // S3 / Storage
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string(),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),

  // Email (SMTP defaults; SES supported via EMAIL_PROVIDER=ses)
  EMAIL_FROM: z.string().email(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: BoolishOptional, // default handled by mailer (true → 465 / false → 587)
  SMTP_TLS_REJECT_UNAUTHORIZED: BoolishOptional,

  // Email provider selection + misc
  EMAIL_PROVIDER: z.enum(["ses", "smtp", "log"]).default("log"),
  EMAIL_SUPPORT_ADDRESS: z.string().email().optional(),
  EMAIL_LINK_SIGNING_SECRET: z.string().optional(), 
  EMAIL_VALIDATE_TRANSPORT: BoolishOptional,

  // AWS region for SES (fallback to S3_REGION if unset)
  AWS_REGION: z.string().optional(),

  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('bowdoin-marketplace'),

  // Feature Flags
  FEATURE_FLAGS: z.string().optional(), // e.g. "newMessaging,brunswickUsers"

  RATE_LIMIT_MULTIPLIER: z.coerce.number().optional(),   // defaults handled in code
  RATE_LIMITS_DISABLED: z.enum(["true", "false"]).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Print flattened errors for quick CI visibility without dumping all env
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables');
}

export const env = parsed.data;

/**
 * Helper: parse feature flags into a Set for O(1) checks.
 * Example: FEATURE_FLAGS="newMessaging,brunswickUsers"
 */
export const featureFlags = new Set(
  env.FEATURE_FLAGS ? env.FEATURE_FLAGS.split(',').map((f) => f.trim()).filter(Boolean) : []
);