// packages/db/src/index.ts
import { env } from '@bowdoin/config/env';
import { logger } from '@bowdoin/observability/logger';
import { getTracer } from '@bowdoin/observability/tracing';
import { PrismaClient, type Prisma } from '@prisma/client';

const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

/**
 * Prisma logging: dev = verbose (query timing); prod = warn/error only.
 */
const prismaLog: Prisma.LogDefinition[] = isProd
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

/**
 * Singleton PrismaClient across hot reloads.
 */
declare global {
  // eslint-disable-next-line no-var
  var __PRISMA__: PrismaClient | undefined;
}

function createPrisma(): PrismaClient {
  // Build options without writing undefined (exactOptionalPropertyTypes-friendly)
  const opts: ConstructorParameters<typeof PrismaClient>[0] = {
    log: prismaLog,
    errorFormat: isProd ? 'minimal' : 'colorless',
  };
  if (env.DATABASE_URL) {
    opts.datasources = { db: { url: env.DATABASE_URL } };
  }

  const client = new PrismaClient(opts);

  // ---------- Bridge Prisma event logs -> pino (DTS-safe)
  // During .d.ts builds, $on overloads can collapse; cast the registrar.
  const onAny = (client as any).$on.bind(client as any);
  const wants = (level: Prisma.LogLevel) =>
    prismaLog.some((d) => d.emit === 'event' && d.level === level);

  if (wants('query')) {
    onAny('query', (e: Prisma.QueryEvent) => {
      if (!isProd) {
        const { query, params, duration, target } = e;
        logger.debug(
          { query, params, duration, target, component: 'prisma' },
          'prisma.query',
        );
      }
    });
  }
  if (wants('info')) {
    onAny('info', (e: Prisma.LogEvent) => {
      logger.info({ component: 'prisma', ...e }, 'prisma.info');
    });
  }
  if (wants('warn')) {
    onAny('warn', (e: Prisma.LogEvent) => {
      logger.warn({ component: 'prisma', ...e }, 'prisma.warn');
    });
  }
  if (wants('error')) {
    onAny('error', (e: Prisma.LogEvent) => {
      logger.error({ component: 'prisma', ...e }, 'prisma.error');
    });
  }

  // ---------- Optional: tie Prisma queries into OTEL spans
  const tracer = getTracer();
  client.$use(async (params, next) => {
    return tracer.startActiveSpan(
      `prisma.${params.model ?? 'raw'}.${params.action}`,
      // span type varies by OTEL SDK; keep as any to avoid importing enums here
      async (span: any) => {
        try {
          if (params.model) span.setAttribute('db.sql.table', params.model);
          span.setAttribute('db.operation', params.action);
          const result = await next(params);
          return result;
        } catch (err) {
          span.recordException(err as Error);
          // STATUS_CODE_ERROR = 2 (avoid importing otel types/enums)
          span.setStatus({ code: 2 });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  });

  return client;
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
 * round-trips with NOW() and version(). Null-safe for DTS.
 */
export async function dbHealthCheck(): Promise<{
  ok: boolean;
  now?: string | null;
  version?: string | null;
  error?: string;
}> {
  try {
    const rowsNow = await prisma.$queryRawUnsafe<Array<{ now: string }>>(
      'SELECT NOW()::text as now;',
    );
    const rowsVer = await prisma.$queryRawUnsafe<Array<{ version: string }>>(
      'SELECT version();',
    );
    const now = rowsNow?.[0]?.now ?? null;
    const version = rowsVer?.[0]?.version ?? null;
    return { ok: true, now, version };
  } catch (err) {
    logger.error({ err }, 'db.health.failed');
    return { ok: false, error: (err as Error).message };
  }
}

/** Transaction helper with correct typing. */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: Parameters<PrismaClient['$transaction']>[1],
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx), options);
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

// Optional default export
export default prisma;