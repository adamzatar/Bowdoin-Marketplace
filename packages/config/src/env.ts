/* eslint-env node */
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
  z.boolean().optional(),
);

/**
 * Strict runtime environment schema.
 * Apps/services should call `validateEnv()` during bootstrap to enforce this.
 */
const StrictEnvSchema = z.object({
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
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().positive().optional(),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.enum(['true', 'false']).optional(),
  REDIS_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().optional(),

  // S3 / Storage
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
  S3_IMAGE_CACHE_CONTROL: z.string().optional(),
  IMAGE_OUTPUT_FORMAT: z.enum(['webp', 'jpeg', 'png', 'avif']).optional(),

  // Email (SMTP defaults; SES supported via EMAIL_PROVIDER=ses)
  EMAIL_FROM: z.string().email(),
  // Comma-separated domain allowlist; optional. Example: "bowdoin.edu,example.org"
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: BoolishOptional, // default handled by mailer (true → 465 / false → 587)
  SMTP_TLS_REJECT_UNAUTHORIZED: BoolishOptional,

  // Email provider selection + misc
  EMAIL_PROVIDER: z.enum(['ses', 'smtp', 'log']).default('log'),
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

  RATE_LIMIT_MULTIPLIER: z.coerce.number().optional(), // defaults handled in code
  RATE_LIMITS_DISABLED: z.enum(['true', 'false']).optional(),
});

/**
 * Loose variant used at import-time to avoid throwing in build/CI contexts.
 * Everything becomes optional, with the same coercions/defaults where defined.
 */
const LooseEnvSchema = StrictEnvSchema.partial();

/** Canonical Env type (strict). */
export type Env = z.infer<typeof StrictEnvSchema>;

// Prefer direct process.env access; no globalThis gymnastics needed.
const raw = process.env as Record<string, string | undefined>;

/**
 * Parse loosely at module import time so library builds & CI don’t crash
 * when your full app env isn’t present.
 */
const looseParsed = LooseEnvSchema.safeParse(raw);

if (!looseParsed.success) {
  // Extremely unlikely with partial schema, but log just in case
  console.warn(
    '⚠️  Non-fatal: environment contains invalid shapes (loose parse).',
    looseParsed.error.flatten().fieldErrors,
  );
}

/**
 * Export a best-effort `env` object for libraries/utilities that read optional values.
 * NOTE: Do not rely on strict presence here; call `validateEnv()` in executables.
 */
export const env = (looseParsed.success ? looseParsed.data : {}) as Partial<Env> as Env;

/**
 * Helper: strict validation for app/worker/server entrypoints.
 * Call early in your bootstrap (e.g., Next custom server, workers, CLI) to fail fast.
 *
 * You can also enforce strictness entirely via env: set CONFIG_STRICT=true.
 */
export function validateEnv(): Env {
  const parsed = StrictEnvSchema.safeParse(raw);
  if (!parsed.success) {
    // Print flattened errors for quick CI visibility without dumping all env
    console.error('❌ Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }
  return parsed.data;
}

/** Auto-enforce strict mode if explicitly requested. */
if (process.env.CONFIG_STRICT === 'true') {
  // Override `env` with strict data and throw on failure.
  const strict = validateEnv();
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore – overwrite the exported binding for consumers after this point
  (exports as unknown as { env: Env }).env = strict;
}

/**
 * Helper: parse feature flags into a Set for O(1) checks.
 * Example: FEATURE_FLAGS="newMessaging,brunswickUsers"
 */
export const featureFlags = new Set(
  env.FEATURE_FLAGS ? env.FEATURE_FLAGS.split(',').map((f) => f.trim()).filter(Boolean) : [],
);
