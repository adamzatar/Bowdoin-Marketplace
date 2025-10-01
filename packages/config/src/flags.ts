/**
 * @module @bowdoin/config/flags
 *
 * Small feature-flag utility with:
 *  - Typed flag names inferred from DEFAULTS
 *  - Optional % rollout using a stable hash of an audienceKey
 *  - Env overrides via process.env.FLAG_<NAME>=0|1|true|false
 *  - Helpers: isEnabled(), allFlags(), readOverride(), list()
 *
 * No runtime deps.
 */

/* -----------------------------------------------------------------------------
 * Defaults — tweak for your app
 * --------------------------------------------------------------------------- */
const DEFAULTS = {
  NEW_LISTING_FLOW: false,
  ENABLE_SEARCH_V2: true,
  COMMUNITY_SIGNUP: true,
  RATE_LIMIT_STRICT: false,
} as const;

export type FlagName = keyof typeof DEFAULTS;
export type FlagsRecord = Readonly<Record<FlagName, boolean>>;

export type AudienceKey = string | number;

export interface FlagOptions {
  /**
   * Rollout percentage [0..100].
   * When provided together with `audienceKey`, enables sticky bucketing.
   */
  percent?: number;
  /**
   * Stable audience key (e.g., userId or email hash) to keep bucket assignment sticky.
   */
  audienceKey?: AudienceKey;
}

/* -----------------------------------------------------------------------------
 * Safe env access (works in browser builds too — just returns undefined)
 * --------------------------------------------------------------------------- */
const ENV: Readonly<Record<string, string | undefined>> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/* -----------------------------------------------------------------------------
 * Env overrides (FLAG_<NAME>=0|1|true|false)
 * --------------------------------------------------------------------------- */
export function readOverride(name: FlagName): boolean | undefined {
  const raw = ENV[`FLAG_${name}`];
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined; // ignore malformed values
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
    hash |= 0; // 32-bit
  }
  const positive = hash === -2147483648 ? 0 : Math.abs(hash); // guard for MIN_INT
  return positive % 100; // 0..99
}

/* -----------------------------------------------------------------------------
 * Core API
 * --------------------------------------------------------------------------- */

/**
 * Check if a flag is enabled.
 * Precedence:
 *  1) Env override FLAG_<NAME>=0|1|true|false
 *  2) If both percent and audienceKey provided → rollout gate (sticky)
 *  3) DEFAULTS fallback
 */
export function isEnabled(name: FlagName, opts?: FlagOptions): boolean {
  // 1) Env override
  const override = readOverride(name);
  if (override !== undefined) return override;

  // 2) % rollout (only if both provided and percent within [0, 100])
  if (
    typeof opts?.percent === 'number' &&
    opts.percent >= 0 &&
    opts.percent <= 100 &&
    opts.audienceKey !== undefined
  ) {
    // bucket is 0..99, so percent=100 means always on
    return bucketOf(opts.audienceKey) < Math.floor(opts.percent);
  }

  // 3) Default
  return DEFAULTS[name];
}

/**
 * Resolve all flags for an optional audience (for sticky rollouts).
 * Uses exactOptionalPropertyTypes patterns — no `undefined` props added.
 */
export function allFlags(audienceKey?: AudienceKey): FlagsRecord {
  const out = {} as Record<FlagName, boolean>;
  (Object.keys(DEFAULTS) as FlagName[]).forEach((name) => {
    // You may add per-flag default rollout here if desired:
    // const percent = name === 'NEW_LISTING_FLOW' ? 10 : undefined;

    const opts: FlagOptions = {};
    if (audienceKey !== undefined) opts.audienceKey = audienceKey;
    // if (percent !== undefined) opts.percent = percent;

    out[name] = isEnabled(name, opts);
  });
  return Object.freeze(out);
}

/** Convenience: typed list of all flag names. */
export const ALL_FLAGS = Object.freeze(Object.keys(DEFAULTS) as FlagName[]);

/** Export defaults for tests/inspection. */
export const DEFAULT_FLAG_VALUES: FlagsRecord = Object.freeze({ ...DEFAULTS });

/* -----------------------------------------------------------------------------
 * Project-specific tweakables (keep colocated with flags)
 * --------------------------------------------------------------------------- */

/**
 * Misc numeric “flags” that aren’t boolean (kept minimal; no runtime deps).
 * Example: VERIFY_CONFIRM_DELAY_MS — optional delay for UX polish in verification flows.
 */
function parsePositiveIntEnv(key: string, fallback = 0): number {
  const raw = ENV[key];
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const flags = Object.freeze({
  VERIFY_CONFIRM_DELAY_MS: parsePositiveIntEnv('VERIFY_CONFIRM_DELAY_MS', 0),
});

/* -----------------------------------------------------------------------------
 * Tiny helpers for consumers that like a functional style
 * --------------------------------------------------------------------------- */

/**
 * Create a resolver bound to a specific audience (avoids re-passing options).
 */
export function createFlagResolver(audienceKey: AudienceKey) {
  return {
    isEnabled: (name: FlagName, percent?: number) =>
      isEnabled(name, percent !== undefined ? { percent, audienceKey } : { audienceKey }),
    all: () => allFlags(audienceKey),
  };
}

/**
 * Human-readable dump of current flags (defaults + overrides applied for the audience).
 */
export function list(audienceKey?: AudienceKey): Array<{ name: FlagName; enabled: boolean }> {
  const record = allFlags(audienceKey);
  return ALL_FLAGS.map((name) => ({ name, enabled: record[name] }));
}
