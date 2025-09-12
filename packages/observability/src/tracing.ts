// packages/observability/src/tracing.ts
/**
 * @module @bowdoin/observability/tracing
 * OpenTelemetry tracing bootstrap for Node runtimes.
 *
 * Safe-by-default:
 *  - No hard build-time deps on OTEL (soft-require at runtime).
 *  - If OTEL is missing, we degrade to no-op tracing and log once.
 *  - Graceful shutdown hooks when enabled.
 */

import { createRequire } from 'node:module';
import process from 'node:process';
import { logger } from './logger';

const requireShim = createRequire(import.meta.url);

/** Soft require that avoids static analysis of module names. */
function softRequire(mod: string): unknown | null {
  try {
    // eslint-disable-next-line no-new-func
    const req = Function('r', 'm', 'return r(m)')(requireShim, mod) as unknown;
    return req;
  } catch {
    return null;
  }
}

/* ─────────────────────────── internal state ─────────────────────────── */

let provider: unknown | null = null;
let getTracerApi: ((name?: string) => unknown) | null = null;
let otelLoaded = false;
let warnedOnce = false;

/* ─────────────────────────── env helpers ─────────────────────────── */

function getEnv(key: string): string | undefined {
  const v = process?.env?.[key];
  return v && String(v).trim() ? String(v).trim() : undefined;
}

function parseRatio(raw: string | undefined): number {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function safeJson(maybeJson: string | undefined): Record<string, string> | undefined {
  if (!maybeJson) return undefined;
  try {
    const parsed = JSON.parse(maybeJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

/* ─────────────────────────── init ─────────────────────────── */

export function initTracing(): void {
  if (provider || otelLoaded) return;

  // Lazy-load everything; if any soft-require fails we run without tracing.
  const otelApi = softRequire('@opentelemetry/api');
  const resourcesMod = softRequire('@opentelemetry/resources');
  const semconv = softRequire('@opentelemetry/semantic-conventions');
  const sdkNode = softRequire('@opentelemetry/sdk-trace-node');
  const sdkBase = softRequire('@opentelemetry/sdk-trace-base');
  const exporterHttp = softRequire('@opentelemetry/exporter-trace-otlp-http');
  const instr = softRequire('@opentelemetry/instrumentation');
  const autoNode = softRequire('@opentelemetry/auto-instrumentations-node');
  const core = softRequire('@opentelemetry/core');

  if (!otelApi || !resourcesMod || !semconv || !sdkNode || !sdkBase || !exporterHttp || !instr || !autoNode || !core) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.info(
        {},
        '[observability] OpenTelemetry not installed; tracing disabled (no-op).',
      );
    }
    return;
  }

  otelLoaded = true;

  // Enable OTEL diag debug only if LOG_LEVEL=debug
  try {
    const api = otelApi as {
      diag?: { setLogger?: (l: unknown, lvl: unknown) => void };
      DiagConsoleLogger?: new () => unknown;
      DiagLogLevel?: { DEBUG: unknown };
    };
    if (getEnv('LOG_LEVEL') === 'debug' && api?.diag && api.DiagConsoleLogger && api.DiagLogLevel) {
      api.diag.setLogger?.(new api.DiagConsoleLogger(), api.DiagLogLevel.DEBUG);
    }
  } catch {
    /* ignore */
  }

  // Resource (service.name/version/env)
  const Resource = (resourcesMod as { Resource: new (attrs: Record<string, unknown>) => unknown }).Resource;
  const {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  } = semconv as {
    SEMRESATTRS_SERVICE_NAME: string;
    SEMRESATTRS_SERVICE_VERSION: string;
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT: string;
  };

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]:
      getEnv('OTEL_SERVICE_NAME') ?? getEnv('APP_NAME') ?? 'bowdoin-marketplace',
    [SEMRESATTRS_SERVICE_VERSION]: getEnv('APP_VERSION') ?? '0.0.0',
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: getEnv('NODE_ENV') ?? 'development',
  });

  // Sampler: parent-based with optional ratio
  const ratio = parseRatio(getEnv('OTEL_TRACES_SAMPLER_ARG'));

  const NodeTracerProvider = (sdkNode as { NodeTracerProvider: new (cfg: unknown) => unknown }).NodeTracerProvider;
  const {
    AlwaysOnSampler,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
    BatchSpanProcessor,
  } = sdkBase as {
    AlwaysOnSampler: new () => unknown;
    ParentBasedSampler: new (cfg: { root: unknown }) => unknown;
    TraceIdRatioBasedSampler: new (r: number) => unknown;
    BatchSpanProcessor: new (exporter: unknown, cfg: unknown) => unknown;
  };

  const rootSampler = ratio >= 1 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(ratio);
  const sampler = new ParentBasedSampler({ root: rootSampler });

  // Provider
  provider = new (NodeTracerProvider as new (cfg: { resource: unknown; sampler: unknown }) => {
    addSpanProcessor: (p: unknown) => void;
    register: (opts?: unknown) => void;
    shutdown: () => Promise<void>;
  })({ resource, sampler });

  // Exporter & processor (omit undefined keys)
  const OTLPTraceExporter = (exporterHttp as {
    OTLPTraceExporter: new (cfg?: { url?: string; headers?: Record<string, string> }) => unknown;
  }).OTLPTraceExporter;

  const url = getEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?? getEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
  const headers = safeJson(getEnv('OTEL_EXPORTER_OTLP_HEADERS'));

  const exporterCfg: { url?: string; headers?: Record<string, string> } = {};
  if (url) exporterCfg.url = url;
  if (headers && Object.keys(headers).length > 0) exporterCfg.headers = headers;

  const exporter = new OTLPTraceExporter(exporterCfg);

  (provider as { addSpanProcessor: (p: unknown) => void }).addSpanProcessor(
    new BatchSpanProcessor(exporter, {
      maxExportBatchSize: 512,
      scheduledDelayMillis: 500,
      maxQueueSize: 4096,
      exportTimeoutMillis: 10_000,
    }),
  );

  // Propagators
  const { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } = core as {
    CompositePropagator: new (cfg: { propagators: unknown[] }) => unknown;
    W3CTraceContextPropagator: new () => unknown;
    W3CBaggagePropagator: new () => unknown;
  };

  (provider as { register: (opts?: { propagator?: unknown }) => void }).register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });

  // Auto-instrumentations (best-effort)
  try {
    const { registerInstrumentations } = instr as { registerInstrumentations: (cfg: { instrumentations: unknown[] }) => void };
    const { getNodeAutoInstrumentations } = autoNode as { getNodeAutoInstrumentations: (cfg: Record<string, unknown>) => unknown };

    registerInstrumentations({
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-http': {
            enabled: true,
            ignoreIncomingPaths: ['/healthz', '/readyz', '/api/healthz', '/api/readyz'],
            headersToSpanAttributes: {
              client: {
                requestHeaders: { 'user-agent': true },
                responseHeaders: { 'content-type': true },
              },
              server: {
                requestHeaders: {
                  'user-agent': true,
                  authorization: false,
                  cookie: false,
                },
                responseHeaders: { 'content-type': true },
              },
            },
          },
          '@opentelemetry/instrumentation-pg': {
            enhancedDatabaseReporting: true,
            requireParentSpan: false,
          },
          '@opentelemetry/instrumentation-undici': { enabled: true },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
  } catch (e) {
    logger.debug({ err: (e as Error)?.message }, '[observability] auto-instrumentations unavailable');
  }

  // Expose tracer getter
  getTracerApi = (name?: string) => {
    const api = otelApi as { trace?: { getTracer?: (n?: string) => unknown } };
    return api.trace?.getTracer?.(name ?? 'app');
  };

  logger.info(
    {
      endpoint: url,
      sampler: ratio >= 1 ? 'parent_always_on' : `parent_ratio_${ratio}`,
    },
    'OpenTelemetry tracing initialized',
  );

  // Graceful shutdown (do not return promises from signal handlers)
  type NodeSignal = 'SIGTERM' | 'SIGINT';
  const shutdown = async (signal: NodeSignal) => {
    try {
      logger.info({ signal }, 'Shutting down OpenTelemetry tracing…');
      await (provider as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
    } catch (err) {
      logger.error({ err }, 'Error during OpenTelemetry shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

/* ─────────────────────────── public API ─────────────────────────── */

/**
 * Retrieve a tracer for manual spans.
 * If OTEL is not available, returns a no-op tracer.
 */
export function getTracer(name = 'app'): {
  startSpan: (n: string) => unknown;
  startActiveSpan: <T>(n: string, fn: (span: unknown) => T) => T;
} {
  if (provider && getTracerApi) {
    return (getTracerApi(name) as unknown) as ReturnType<typeof getTracer>;
  }
  initTracing();
  if (provider && getTracerApi) {
    return (getTracerApi(name) as unknown) as ReturnType<typeof getTracer>;
  }
  return noopTracer;
}

/** Force shutdown (useful in tests). */
export async function shutdownTracing(): Promise<void> {
  try {
    await (provider as { shutdown?: () => Promise<void> } | null)?.shutdown?.();
  } catch {
    // ignore
  } finally {
    provider = null;
  }
}

/* ─────────────────────────── no-op tracer ─────────────────────────── */

const noopSpan = {
  end: () => {},
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  setStatus: () => noopSpan,
  updateName: () => noopSpan,
  isRecording: () => false,
};

const noopTracer = {
  startSpan: (): typeof noopSpan => noopSpan,
  startActiveSpan: <T>(_name: string, fn: (span: unknown) => T): T => fn(noopSpan),
};

// Legacy named export for convenience
export const tracer = getTracer();