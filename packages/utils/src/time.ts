/**
 * @module @bowdoin/utils/time
 * Safe, dependency-free time/date utilities targetting Node 18+ & modern browsers.
 * - Strong typing for ISO strings and Unix epochs
 * - Precise duration math (ms) with readable helpers
 * - Monotonic timers (performance.now / hrtime.bigint)
 * - RFC3339/ISO8601 parsing/formatting without locale pitfalls
 */

import { performance } from 'node:perf_hooks';

/* ========================================================================== *
 * Types
 * ========================================================================== */

export type Millis = number & { __brand: 'Millis' };
export type Seconds = number & { __brand: 'Seconds' };
export type UnixSeconds = number & { __brand: 'UnixSeconds' };
export type UnixMillis = number & { __brand: 'UnixMillis' };
/** ISO 8601 / RFC3339 string, e.g. "2025-09-04T21:22:11.123Z" */
export type ISODateString = string & { __brand: 'ISODateString' };

/* ========================================================================== *
 * Constants
 * ========================================================================== */

export const MS = {
  second: 1_000 as Millis,
  minute: 60_000 as Millis,
  hour: 3_600_000 as Millis,
  day: 86_400_000 as Millis,
  week: 604_800_000 as Millis,
  /** Approximate month (30 days). Prefer addMonths for calendar math. */
  monthApprox: (86_400_000 * 30) as Millis,
} as const;

export const SEC = {
  minute: 60 as Seconds,
  hour: 3_600 as Seconds,
  day: 86_400 as Seconds,
  week: 604_800 as Seconds,
} as const;

/* ========================================================================== *
 * Now / Epoch
 * ========================================================================== */

/** Current wall-clock time in milliseconds since Unix epoch (UTC). */
export const nowMs = (): UnixMillis => Date.now() as UnixMillis;
/** Current monotonic time in milliseconds (not wall-clock, not subject to NTP). */
export const nowMonoMs = (): Millis => performance.now() as Millis;
/** Current time as ISO string (UTC). */
export const nowISO = (): ISODateString => new Date().toISOString() as ISODateString;
/** Convert Date → ISO (UTC). */
export const toISO = (d: Date): ISODateString => d.toISOString() as ISODateString;
/** Convert ISO string → Date (throws if invalid). */
export const fromISO = (iso: string): Date => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return d;
};
/** Convert Date → Unix seconds (UTC). */
export const toUnixSeconds = (d: Date): UnixSeconds =>
  Math.floor(d.getTime() / 1000) as UnixSeconds;
/** Convert Date → Unix milliseconds (UTC). */
export const toUnixMillis = (d: Date): UnixMillis => d.getTime() as UnixMillis;
/** Convert Unix seconds → Date. */
export const fromUnixSeconds = (s: number): Date => new Date(s * 1000);
/** Convert Unix milliseconds → Date. */
export const fromUnixMillis = (ms: number): Date => new Date(ms);

/* ========================================================================== *
 * Safe Parsing
 * ========================================================================== */

/**
 * Parse common input into Date or return null (no throw).
 * Accepts Date, ISO string, number (ms or seconds if < 1e12).
 */
export function parseDateSafe(input: Date | string | number): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const ms = input < 1e12 ? input * 1000 : input; // heuristic: seconds vs ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === 'string') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/* ========================================================================== *
 * Duration / Sleep
 * ========================================================================== */

export const ms = (n: number): Millis => n as Millis;
export const seconds = (n: number): Seconds => n as Seconds;

export const toMillis = {
  fromSeconds: (s: Seconds): Millis => (s * 1000) as Millis,
};

export const toSeconds = {
  fromMillis: (m: Millis): Seconds => (Math.floor(m / 1000) as Seconds),
};

/** Sleep utility (Node & browser). */
export const sleep = (durationMs: Millis): Promise<void> =>
  new Promise((res) => setTimeout(res, durationMs));

/** Stopwatch for performance measurements (monotonic). */
export function stopwatch() {
  const start = nowMonoMs();
  return {
    elapsed: (): Millis => (nowMonoMs() - start) as Millis,
    toString: () => `${(nowMonoMs() - start).toFixed(2)}ms`,
  };
}

/* ========================================================================== *
 * Arithmetic (UTC)
 * ========================================================================== */

export const addMillis = (d: Date, m: Millis): Date => new Date(d.getTime() + m);
export const addSeconds = (d: Date, s: Seconds): Date => new Date(d.getTime() + s * 1000);
export const addDays = (d: Date, days: number): Date => addMillis(d, ms(days * MS.day));
export const addHours = (d: Date, hours: number): Date => addMillis(d, ms(hours * MS.hour));
export const addMinutes = (d: Date, minutes: number): Date =>
  addMillis(d, ms(minutes * MS.minute));

/**
 * Calendar-accurate month addition (handles month-end overflow).
 * @example addMonths(new Date('2024-01-31T00:00:00Z'), 1) -> 2024-02-29T00:00:00Z
 */
export function addMonths(d: Date, months: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetMonth = month + months;
  const y = year + Math.floor(targetMonth / 12);
  const m = ((targetMonth % 12) + 12) % 12;
  // clamp day to end of target month
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(
    Date.UTC(
      y,
      m,
      clampedDay,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

/* ========================================================================== *
 * Ranges / Rounding (UTC)
 * ========================================================================== */

export const startOfDayUTC = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const endOfDayUTC = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));

/** Clamp a date within [min, max]. */
export const clampDate = (d: Date, min: Date, max: Date): Date =>
  d < min ? min : d > max ? max : d;

/** Is Date `d` within [from, to] inclusive? */
export const isBetween = (d: Date, from: Date, to: Date): boolean =>
  d.getTime() >= from.getTime() && d.getTime() <= to.getTime();

/* ========================================================================== *
 * Formatting
 * ========================================================================== */

/** RFC3339 with millisecond precision, UTC (same as Date.toISOString). */
export const formatRFC3339 = (d: Date): ISODateString =>
  d.toISOString() as ISODateString;

/**
 * Human readable duration (e.g., "2h 03m", "45s", "1d 4h").
 * For logs/metrics only (do not localize).
 */
export function formatDuration(msTotal: number): string {
  if (!Number.isFinite(msTotal) || msTotal < 0) return '0ms';
  let rem = Math.floor(msTotal);
  const d = Math.floor(rem / MS.day);
  rem -= d * MS.day;
  const h = Math.floor(rem / MS.hour);
  rem -= h * MS.hour;
  const m = Math.floor(rem / MS.minute);
  rem -= m * MS.minute;
  const s = Math.floor(rem / MS.second);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  if (parts.length === 0) parts.push(`${rem}ms`);
  return parts.join(' ');
}

/* ========================================================================== *
 * Deadlines / Timeouts
 * ========================================================================== */

/**
 * Run a promise with an absolute deadline.
 * Rejects with TimeoutError if the deadline elapses first.
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: UnixMillis,
  onTimeout?: () => void,
): Promise<T> {
  const remaining = Math.max(0, deadlineMs - nowMs());
  return withTimeout(work, ms(remaining), onTimeout);
}

/**
 * Run a promise with a relative timeout (ms).
 * Rejects with TimeoutError if it exceeds.
 */
export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: Millis,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError());
    }, timeoutMs);

    work
      .then((v) => resolve(v))
      .catch((e) => reject(e))
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  });
}

/* ========================================================================== *
 * Windows / Intervals
 * ========================================================================== */

/** Return [start, end] UTC window for a given day count ending now. */
export function windowLastDays(days: number): [Date, Date] {
  const end = new Date();
  const start = addDays(startOfDayUTC(end), -Math.max(0, Math.floor(days - 1)));
  return [start, end];
}

/** True if two dates fall on the same UTC calendar day. */
export const isSameUtcDay = (a: Date, b: Date): boolean =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

/* ========================================================================== *
 * Serializable helpers
 * ========================================================================== */

/** Ensures an ISO string type (no validation beyond Date constructor). */
export const asISO = (s: string): ISODateString => s as ISODateString;
/** Ensures millis type. */
export const asMillis = (n: number): Millis => n as Millis;
/** Ensures unix ms type. */
export const asUnixMillis = (n: number): UnixMillis => n as UnixMillis;
/** Ensures unix seconds type. */
export const asUnixSeconds = (n: number): UnixSeconds => n as UnixSeconds;