// packages/queue/src/connection.ts

import { env } from '@bowdoin/config/env';
import { logger } from '@bowdoin/observability/logger';
import { diag, trace } from '@opentelemetry/api';
import { Queue, Worker, QueueScheduler, type JobsOptions, type Processor } from 'bullmq';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';

const tracer = trace.getTracer('queue');
const log = logger.child({ module: 'queue:connection' });

/**
 * IMPORTANT: BullMQ requires a full Redis feature set (Lua scripting, evalsha, etc).
 * Upstash serverless Redis is NOT compatible for BullMQ. It is fine for token buckets/rate-limits,
 * but for queues you should point at a self-hosted Redis or a compatible managed Redis.
 */
function assertBullCompatible() {
  const url = env.REDIS_URL ?? '';
  if (url.includes('upstash.io')) {
    const msg =
      'Detected Upstash Redis URL. Upstash is not BullMQ compatible. ' +
      'Use self-hosted/compatible Redis for queues (you can still use Upstash for rate limits).';
    log.error({ urlMasked: maskUrl(url) }, msg);
    throw new Error(msg);
  }
}

/** Mask credentials in URLs for logs */
function maskUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    if (u.username) u.username = '****';
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}

type Role = 'client' | 'subscriber';

/** Build ioredis options from env with sane defaults */
function buildRedisOptions(role: Role): RedisOptions {
  // Highest precedence: REDIS_URL (includes auth/tls)
  if (env.REDIS_URL) {
    return {
      lazyConnect: true,
      maxRetriesPerRequest: null, // recommended for BullMQ
      enableReadyCheck: true,
      ...(env.NODE_ENV === 'production' ? { enableOfflineQueue: false } : {}),
      tls: env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    } as RedisOptions & { host?: string; port?: number };
  }

  // Host/port style
  const tls =
    env.REDIS_TLS === 'true'
      ? {
          rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
        }
      : undefined;

  return {
    host: env.REDIS_HOST || '127.0.0.1',
    port: env.REDIS_PORT ? Number(env.REDIS_PORT) : 6379,
    username: env.REDIS_USERNAME || undefined,
    password: env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...(env.NODE_ENV === 'production' ? { enableOfflineQueue: false } : {}),
    tls,
  };
}

/** Create a single Redis connection */
function createRedis(role: Role): Redis {
  const opts = buildRedisOptions(role);

  const client =
    env.REDIS_URL != null
      ? new IORedis(env.REDIS_URL, opts)
      : new IORedis(opts);

  client.on('error', (err) => {
    log.error({ err, role }, 'Redis error');
    diag.error('Redis error', err as Error);
  });
  client.on('connect', () => log.info({ role }, 'Redis connected'));
  client.on('close', () => log.warn({ role }, 'Redis connection closed'));
  client.on('reconnecting', () => log.warn({ role }, 'Redis reconnecting'));

  return client;
}

/** Singleton connection bundle shared by queues/workers */
let shared: {
  connection: Redis;
  subscriber: Redis;
} | null = null;

export function getRedisConnections() {
  if (!shared) {
    assertBullCompatible();
    shared = {
      connection: createRedis('client'),
      subscriber: createRedis('subscriber'),
    };
  }
  return shared;
}

/** Ensure both connections are live (connect if lazy) */
export async function connectRedis(): Promise<void> {
  const { connection, subscriber } = getRedisConnections();
  await Promise.all([connection.connect(), subscriber.connect()]);
  // quick ping
  const pong = await connection.ping();
  log.info({ pong }, 'Redis ping');
}

/** Graceful teardown */
export async function disconnectRedis(): Promise<void> {
  if (!shared) return;
  const { connection, subscriber } = shared;
  shared = null;
  await Promise.allSettled([connection.quit(), subscriber.quit()]);
}

/** BullMQ connection factory for Queue/Worker */
function bullConnection() {
  const { connection } = getRedisConnections();
  return connection;
}

export type QueueFactoryOptions = {
  /** Prefix for keys. Defaults to `bmq` to avoid clobbering other Redis users. */
  prefix?: string;
  /** Default job options for the queue. */
  defaultJobOptions?: JobsOptions;
};

/** Create a queue + scheduler pair with sane, productiony defaults. */
export function createQueue<T = unknown>(
  name: string,
  options: QueueFactoryOptions = {},
) {
  const prefix = options.prefix ?? 'bmq';
  const connection = bullConnection();

  const queue = new Queue<T>(name, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 60 * 60, count: 1000 }, // keep an hour or 1k jobs
      removeOnFail: { age: 24 * 60 * 60, count: 1000 },
      ...(options.defaultJobOptions ?? {}),
    },
  });

  const scheduler = new QueueScheduler(name, {
    connection,
    prefix,
  });

  scheduler.on('failed', (jobId, err) => {
    log.error({ queue: name, jobId, err }, 'QueueScheduler failed job');
  });

  return { queue, scheduler };
}

export type WorkerFactoryOptions = {
  /** Concurrency for the worker. */
  concurrency?: number;
  /** Prefix for keys. Must match the queue’s prefix. */
  prefix?: string;
  /** Enable metrics events logging. */
  metrics?: boolean;
};

/** Create a worker with tracing + structured logs */
export function createWorker<T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  options: WorkerFactoryOptions = {},
) {
  const connection = bullConnection();
  const prefix = options.prefix ?? 'bmq';

  const worker = new Worker<T, R>(name, async (job, token) => {
    return tracer.startActiveSpan(`worker:${name}`, async (span) => {
      span.setAttribute('queue.name', name);
      span.setAttribute('job.id', job.id as string);
      span.setAttribute('job.name', job.name);
      span.setAttribute('job.attempts', job.attemptsMade);

      const start = Date.now();
      try {
        log.info(
          { queue: name, jobId: job.id, name: job.name, attempts: job.attemptsMade },
          'Processing job',
        );

        const res = await processor(job, token);

        const durationMs = Date.now() - start;
        span.setAttribute('job.duration_ms', durationMs);
        span.end();

        log.info(
          { queue: name, jobId: job.id, name: job.name, durationMs },
          'Job complete',
        );
        return res;
      } catch (err) {
        const durationMs = Date.now() - start;
        span.recordException(err as Error);
        span.setAttribute('job.duration_ms', durationMs);
        span.end();

        log.error(
          { queue: name, jobId: job.id, err, durationMs },
          'Job failed',
        );
        throw err;
      }
    });
  }, {
    connection,
    prefix,
    concurrency: options.concurrency ?? Math.max(1, Number(env.WORKER_CONCURRENCY ?? 4)),
  });

  worker.on('failed', (job, err) => {
    log.error({ queue: name, jobId: job?.id, err }, 'Worker failed');
  });
  worker.on('completed', (job, result) => {
    log.debug({ queue: name, jobId: job.id, result }, 'Worker completed');
  });

  if (options.metrics) {
    worker.on('active', (job) => {
      log.debug({ queue: name, jobId: job.id }, 'Worker active');
    });
    worker.on('stalled', (jobId) => {
      log.warn({ queue: name, jobId }, 'Worker stalled');
    });
  }

  return worker;
}

/** Register SIGINT/SIGTERM handlers for graceful shutdown (idempotent) */
let signalsRegistered = false;
export function registerQueueSignalHandlers() {
  if (signalsRegistered) return;
  signalsRegistered = true;

  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'Shutting down queues gracefully');
    try {
      await disconnectRedis();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}