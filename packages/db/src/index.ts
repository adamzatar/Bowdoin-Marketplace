// packages/db/src/index.ts

import { env } from '@bowdoin/config/env';
import { logger } from '@bowdoin/observability/logger';
import { getTracer } from '@bowdoin/observability/tracing';
import { PrismaClient, type Prisma } from '@prisma/client';

// --- Local, Prisma-v6-safe types (no private imports) ------------------------
type LogLevel = 'query' | 'info' | 'warn' | 'error';
type LogEmit = 'event' | 'stdout';
type LogDefinition = { level: LogLevel; emit: LogEmit };

interface QueryEvent {
  query: string;
  params: string;
  duration: number;
  target?: string;
}

interface LogEvent {
  message: string;
}

interface MiddlewareParams {
  model?: string | undefined;
  action: string;
}

type MiddlewareNext = (params: MiddlewareParams) => Promise<unknown>;

// Minimal Span + Tracer contracts without @opentelemetry/api
type SpanLike = {
  setAttribute(key: string, value: unknown): void;
  setStatus?(status: { code: number; message?: string }): void;
  recordException?(err: unknown): void;
  end(): void;
};
type TracerLike = {
  startActiveSpan: (
    name: string,
    fn: (span: unknown) => Promise<unknown> | unknown
  ) => Promise<unknown> | unknown;
};

function isSpanLike(x: unknown): x is SpanLike {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as SpanLike).end === 'function' &&
    typeof (x as SpanLike).setAttribute === 'function'
  );
}

function isTracerLike(x: unknown): x is TracerLike {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as TracerLike).startActiveSpan === 'function'
  );
}

// --- Env flags ----------------------------------------------------------------
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

// --- Log configuration compatible with Prisma v6 ------------------------------
const prismaLog: LogDefinition[] = isProd
  ? [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ]
  : [
      { level: 'query', emit: 'event' },
      { level: 'info', emit: 'event' },
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ];

type PrismaClientConfig = {
  log?: LogDefinition[] | undefined;
  errorFormat?: 'minimal' | 'colorless' | 'pretty' | undefined;
  datasources?: {
    db?: {
      url?: string | undefined;
    } | undefined;
  } | undefined;
};

type PrismaClientEvents = PrismaClient & {
  $on(event: LogLevel, handler: (event: unknown) => void): void;
  $on(event: 'beforeExit', handler: () => void): void;
};

type QueryContext = {
  model?: string;
  operation: string;
  args: unknown;
  query(args: unknown): Promise<unknown>;
};

function runWithSpan(
  tracer: TracerLike | null,
  params: MiddlewareParams,
  next: MiddlewareNext,
): Promise<unknown> {
  if (!tracer) return next(params);

  const ERROR_CODE = 2; // SpanStatusCode.ERROR equivalent

  return tracer.startActiveSpan(
    `prisma.${params.model ?? 'raw'}.${params.action}`,
    async (span: unknown) => {
      const s = isSpanLike(span) ? span : undefined;
      try {
        if (s && params.model) s.setAttribute('db.sql.table', params.model);
        if (s) s.setAttribute('db.operation', params.action);
        return await next(params);
      } catch (err) {
        s?.recordException?.(err);
        s?.setStatus?.({ code: ERROR_CODE });
        throw err;
      } finally {
        s?.end?.();
      }
    },
  ) as Promise<unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __PRISMA__: PrismaClient | undefined;
}

function createPrisma(): PrismaClient {
  // `ConstructorParameters<typeof PrismaClient>[0]` is `unknown` in v6 typings.
  // Build a plain options object and pass it directly.
  const opts: PrismaClientConfig = {
    log: prismaLog,
    errorFormat: isProd ? 'minimal' : 'colorless',
    datasources: env.DATABASE_URL ? { db: { url: env.DATABASE_URL } } : undefined,
  };

  // No generics on PrismaClient in v6
  const client = new PrismaClient(opts as never);
  const events = client as PrismaClientEvents;

  // ---------- Bridge Prisma event logs -> pino
  const wants = (level: LogLevel) =>
    prismaLog.some((d) => d.emit === 'event' && d.level === level);

  if (wants('query')) {
    events.$on('query', (e: unknown) => {
      const qe = e as Partial<QueryEvent>;
      if (!isProd) {
        const { query, params, duration, target } = qe;
        logger.debug(
          { query, params, duration, target, component: 'prisma' },
          'prisma.query',
        );
      }
    });
  }
  if (wants('info')) {
    events.$on('info', (e: unknown) => {
      const le = e as Partial<LogEvent>;
      logger.info({ component: 'prisma', ...le }, 'prisma.info');
    });
  }
  if (wants('warn')) {
    events.$on('warn', (e: unknown) => {
      const le = e as Partial<LogEvent>;
      logger.warn({ component: 'prisma', ...le }, 'prisma.warn');
    });
  }
  if (wants('error')) {
    events.$on('error', (e: unknown) => {
      const le = e as Partial<LogEvent>;
      logger.error({ component: 'prisma', ...le }, 'prisma.error');
    });
  }

  // ---------- Optional: tie Prisma queries into OTEL spans (no hard dep)
  const tracerMaybe = getTracer();
  const tracer = isTracerLike(tracerMaybe) ? tracerMaybe : null;

  const instrumented = tracer
    ? client.$extends({
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }: QueryContext) {
              const nextFn: MiddlewareNext = async (_params) => query(args);
              return runWithSpan(tracer, { model, action: operation }, nextFn);
            },
          },
        },
      })
    : client;

  return instrumented as PrismaClient;
}

// Reuse singleton in dev; fresh per process in prod/test
export const prisma: PrismaClient = globalThis.__PRISMA__ ?? createPrisma();
if (!isProd && !isTest) {
  globalThis.__PRISMA__ = prisma;
}

/** Ensure a live pool (useful for readyz). */
export async function connectIfNeeded(): Promise<void> {
  try {
    await prisma.$connect();
  } catch (err) {
    logger.error({ err }, 'db.connect.failed');
    throw err;
  }
}

/**
 * Health probe for /api/healthz and /api/readyz:
 * round-trips with NOW() and version().
 */
export async function dbHealthCheck(): Promise<{
  ok: boolean;
  now?: string | null;
  version?: string | null;
  error?: string;
}> {
  try {
    // Remove generics (extended client erases them) and cast results instead.
    const rowsNow = (await prisma.$queryRawUnsafe(
      'SELECT NOW()::text as now;',
    )) as Array<{ now: string }>;

    const rowsVer = (await prisma.$queryRawUnsafe(
      'SELECT version();',
    )) as Array<{ version: string }>;

    const now = rowsNow?.[0]?.now ?? null;
    const version = rowsVer?.[0]?.version ?? null;
    return { ok: true, now, version };
  } catch (err) {
    logger.error({ err }, 'db.health.failed');
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Transaction helper with correct typing. */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: Parameters<PrismaClient['$transaction']>[1],
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => fn(tx), options);
}

/** Graceful shutdown for signal handlers. */
export async function shutdownPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.warn({ err }, 'db.disconnect.warn');
  }
}

// Convenience re-exports
export type { PrismaClient } from '@prisma/client';
export type { Prisma as PrismaTypes } from '@prisma/client';