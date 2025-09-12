/**
 * @module @bowdoin/observability/metrics
 * OpenTelemetry Metrics setup
 * - OTLP exporter
 * - System/runtime metrics
 * - App-level counters & histograms (exported as `counters`, `histograms`)
 */

import { env } from '@bowdoin/config/env';
import { logger } from './logger';

import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
} from '@opentelemetry/api';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Enable diagnostics if debug logging is active (guarded: LOG_LEVEL may not be typed)
if ((env as any).LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

let meterProvider: MeterProvider | null = null;
let meter: Meter | null = null;

/**
 * Initialize metrics provider with OTLP exporter.
 * Call this once during process bootstrap (server start, worker start, etc.).
 */
export function initMetrics(): void {
  if (meterProvider) return; // already initialized

  const exporter = new OTLPMetricExporter({
    url:
      (env as any).OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
      (env as any).OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: (env as any).OTEL_EXPORTER_OTLP_HEADERS
      ? JSON.parse(String((env as any).OTEL_EXPORTER_OTLP_HEADERS))
      : {},
  });

  meterProvider = new MeterProvider();
  meterProvider.addMetricReader(
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000, // 1 min
    }),
  );

  meter = meterProvider.getMeter(
    (env as any).OTEL_SERVICE_NAME ?? (env as any).APP_NAME ?? 'bowdoin-marketplace',
  );

  logger.info(
    { endpoint: (env as any).OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? (env as any).OTEL_EXPORTER_OTLP_ENDPOINT },
    'OpenTelemetry metrics initialized',
  );

  // (Re)bind instruments now that we have a meter.
  bindInstruments();
}

/**
 * Get a named meter for custom metrics (after init).
 */
export function getMeter(name: string) {
  if (!meterProvider) {
    throw new Error('Metrics not initialized. Call initMetrics() first.');
  }
  return meterProvider.getMeter(name);
}

/* ------------------------------------------------------------------------------------------------
 * Instruments (lazy-bound)
 * ------------------------------------------------------------------------------------------------ */

type CounterLike = Pick<Counter, 'add'>;
type HistogramLike = Pick<Histogram, 'record'>;

const noopCounter: CounterLike = { add: () => {} };
const noopHistogram: HistogramLike = { record: () => {} };

/**
 * Exported app counters used across packages (auth, API, email, etc.).
 * These are safe to import anywhere. Before `initMetrics()` is called they are no-ops.
 */
export const counters: {
  authLogins: CounterLike;
  authLoginFailures: CounterLike;
  listingsCreated: CounterLike;
  emailsSent: CounterLike;
  rateLimitHits: CounterLike;
  httpRequests: CounterLike;
  httpRequestErrors: CounterLike;
} = {
  authLogins: noopCounter,
  authLoginFailures: noopCounter,
  listingsCreated: noopCounter,
  emailsSent: noopCounter,
  rateLimitHits: noopCounter,
  httpRequests: noopCounter,
  httpRequestErrors: noopCounter,
};

/**
 * Exported histograms (durations in milliseconds).
 * Safe to use before init; they are no-ops until bound.
 */
export const histograms: {
  httpDurationMs: HistogramLike;
} = {
  httpDurationMs: noopHistogram,
};

/**
 * Bind real instruments to the exported placeholders once a Meter is available.
 */
function bindInstruments() {
  if (!meter) return;

  // Common attributes you may want to attach at call-sites:
  // { route: '/api/listings', method: 'GET', status: 200 }
  counters.authLogins = meter.createCounter('auth.logins', {
    description: 'Successful user logins',
  });
  counters.authLoginFailures = meter.createCounter('auth.login.failures', {
    description: 'Failed user login attempts',
  });
  counters.listingsCreated = meter.createCounter('listings.created', {
    description: 'Listings created',
  });
  counters.emailsSent = meter.createCounter('email.sent', {
    description: 'Emails sent by type',
  });
  counters.rateLimitHits = meter.createCounter('rate_limit.hits', {
    description: 'Requests rejected due to rate limiting',
  });
  counters.httpRequests = meter.createCounter('http.server.requests', {
    description: 'Incoming HTTP requests',
  });
  counters.httpRequestErrors = meter.createCounter('http.server.errors', {
    description: 'HTTP 5xx error responses',
  });

  histograms.httpDurationMs = meter.createHistogram('http.server.duration', {
    description: 'HTTP server request duration in ms',
    unit: 'ms',
  });
}

/* ------------------------------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------------------------------ */

/** Convenience wrapper to record an HTTP request with optional attributes. */
export function recordHttp(
  durationMs: number,
  attrs?: Attributes,
  ok = true,
): void {
  histograms.httpDurationMs.record(durationMs, attrs);
  counters.httpRequests.add(1, attrs);
  if (!ok) counters.httpRequestErrors.add(1, attrs);
}

/* ------------------------------------------------------------------------------------------------
 * Namespace expected by some callers
 * ------------------------------------------------------------------------------------------------ */

export const metrics = {
  init: initMetrics,
  getMeter,
  counters,
  histograms,
  recordHttp,
} as const;