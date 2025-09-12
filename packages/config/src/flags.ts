/**
 * @module @bowdoin/config/flags
 *
 * Small feature-flag utility with:
 *  - Typed flag names inferred from DEFAULTS
 *  - Optional % rollout using a stable hash of an audienceKey
 *  - Env overrides via process.env.FLAG_<NAME>=0|1|true|false
 *  - Helpers: isEnabled(), allFlags()
 *
 * No runtime deps.
 */

/* -----------------------------------------------------------------------------
 * Define defaults here. Add/remove flags as needed.
 * --------------------------------------------------------------------------- */
const DEFAULTS = {
  // Example flags — customize for your app:
  NEW_LISTING_FLOW: false,
  ENABLE_SEARCH_V2: true,
  COMMUNITY_SIGNUP: true,
  RATE_LIMIT_STRICT: false,
} as const;

export type FlagName = keyof typeof DEFAULTS;

/* -----------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */
export type AudienceKey = string | number;

export interface FlagOptions {
  /** Rollout percentage [0..100]; when provided, gates the flag on audienceKey hash */
  percent?: number;
  /** Stable key for hashing (e.g., userId, IP) to keep bucket assignment sticky */
  audienceKey?: AudienceKey;
}

/* -----------------------------------------------------------------------------
 * Env overrides (FLAG_<NAME>=0|1|true|false)
 * --------------------------------------------------------------------------- */
function readEnvOverride(name: FlagName): boolean | undefined {
  const envKey = `FLAG_${name}`;
  const raw = process.env[envKey];
  if (raw === undefined) return undefined;
  const v = String(raw).toLowerCase().trim();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/* -----------------------------------------------------------------------------
 * Stable hash (djb2 variant) -> 0..99 bucket
 * --------------------------------------------------------------------------- */
function bucketOf(key: AudienceKey): number {
  const s = String(key);
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // hash * 33 ^ char
     
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
    // Keep it in 32-bit range
     
    hash |= 0;
  }
  const positive = Math.abs(hash);
  return positive % 100; // 0..99
}

/* -----------------------------------------------------------------------------
 * Core API
 * --------------------------------------------------------------------------- */

/**
 * Check if a flag is enabled.
 * Order of precedence:
 *  1) Env override FLAG_<NAME>=0|1|true|false
 *  2) If options.percent is provided AND audienceKey is provided => rollout gate
 *  3) DEFAULTS fallback
 */
export function isEnabled(name: FlagName, opts?: FlagOptions): boolean {
  // 1) Env override
  const override = readEnvOverride(name);
  if (override !== undefined) return override;

  // 2) % rollout (only if both percent and audienceKey provided)
  if (
    typeof opts?.percent === "number" &&
    opts.percent >= 0 &&
    opts.percent <= 100 &&
    opts.audienceKey !== undefined
  ) {
    const bucket = bucketOf(opts.audienceKey);
    return bucket < Math.floor(opts.percent);
  }

  // 3) Default
  return DEFAULTS[name];
}

/** Convenience: typed list of all flag names. */
export const ALL_FLAGS = Object.keys(DEFAULTS) as FlagName[];

/**
 * Resolve all flags for a given audience.
 * Uses exact optional property types—no `undefined` properties are written.
 */
export function allFlags(audienceKey?: AudienceKey): Record<FlagName, boolean> {
  const out = {} as Record<FlagName, boolean>;

  for (const n of ALL_FLAGS) {
    // Build options without introducing `undefined` fields
    const opts: { percent?: number; audienceKey?: AudienceKey } = {};
    // Example: you can assign a default rollout percent per-flag here if desired:
    // if (n === "NEW_LISTING_FLOW") opts.percent = 10;

    if (audienceKey !== undefined) {
      opts.audienceKey = audienceKey;
    }

    out[n] = isEnabled(n, opts);
  }

  return out;
}

/* -----------------------------------------------------------------------------
 * Export defaults for convenience in consumers/tests
 * --------------------------------------------------------------------------- */
export const DEFAULT_FLAG_VALUES: Readonly<Record<FlagName, boolean>> = DEFAULTS;