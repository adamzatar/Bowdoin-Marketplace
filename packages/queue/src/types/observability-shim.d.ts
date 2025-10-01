/**
 * Editor-only ambient type shims for @bowdoin/observability.
 *
 * Purpose:
 * - Keep VS Code / TS happy in @bowdoin/queue even before the observability
 *   package has been built (so its dist/*.d.ts don’t exist yet).
 * - ZERO runtime effect (this is a .d.ts ambient declaration file).
 *
 * When safe to remove:
 * - After your CI/local workflow ensures @bowdoin/observability is built
 *   before consumers (e.g., via "prep:types" or project references),
 *   these shims can be deleted.
 */

/* eslint-disable @typescript-eslint/consistent-type-definitions */
/* eslint-disable @typescript-eslint/no-unused-vars */

declare module "@bowdoin/observability/logger" {
  type QueueLogger = {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    debug: (obj: unknown, msg?: string) => void;
    child: (bindings: Record<string, unknown>) => QueueLogger;
  };

  /** Minimal logger surface used by the queue worker. */
  export const logger: QueueLogger;
}

declare module "@bowdoin/observability/metrics" {
  /** Attribute bag for metrics dimensions. */
  export type Attrs = Record<string, string | number | boolean>;

  /** Counter-like interface (compatible with OTel-style counters). */
  export type Counter = { add: (n: number, attrs?: Attrs) => void };

  /** Histogram-like interface (compatible with OTel-style histograms). */
  export type Histogram = { record: (n: number, attrs?: Attrs) => void };

  /** Minimal metrics surface used by the queue worker. */
  export const metrics: {
    /** Convenience helper we call to record worker timing. */
    recordHttp: (durationMs: number, attrs?: Attrs) => void;

    /** Named counters (at least httpRequestErrors is expected). */
    counters: {
      httpRequestErrors: Counter;
      [name: string]: Counter;
    };

    /** Named histograms (extendable). */
    histograms: {
      [name: string]: Histogram;
    };
  };
}
