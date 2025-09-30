// apps/web/worker/image-processor.ts
//
// Production-grade image worker entrypoint.
// - Boots tracing/metrics/logging
// - Starts the BullMQ (or equivalent) image-processing worker from the shared queue package
// - Exposes a tiny health server for Kubernetes liveness/readiness
// - Graceful shutdown on SIGINT/SIGTERM (drain jobs, flush spans)
// - Defensive error handling + structured logs
//
// Assumptions (from your monorepo):
// - @bowdoin/queue/workers exports `startImageWorker(opts?)`
//   which returns an object with at least: `{ name: string, close(): Promise<void> }`
// - @bowdoin/observability provides init/shutdown helpers + a pino-like logger
// - @bowdoin/config exports validated env (zod) including optional worker overrides
//
// If any of those contracts differ, adjust the imports / calls below.

import http from 'node:http';
import process from 'node:process';

import { env } from '@bowdoin/config/env';
import { logger } from '@bowdoin/observability/logger';
import { metrics } from '@bowdoin/observability/metrics';
import { initTracing, shutdownTracing } from '@bowdoin/observability/tracing';
import { startImageWorker } from '@bowdoin/queue/workers';
import type { Counter } from '@opentelemetry/api';

// ---------- Config ----------
const SERVICE_NAME = 'image-processor';
const START_TS = Date.now();

const HEALTH_PORT = Number(process.env.IMAGE_WORKER_HEALTH_PORT ?? process.env.PORT ?? 8081);
const CONCURRENCY = Number(process.env.IMAGE_WORKER_CONCURRENCY ?? env?.WORKER_CONCURRENCY ?? 4);

// how long to wait for graceful shutdown before forcing exit
const SHUTDOWN_DEADLINE_MS = Number(process.env.IMAGE_WORKER_SHUTDOWN_DEADLINE_MS ?? 25_000);

type WorkerLike = {
  name?: string;
  close: () => Promise<void>;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
};

// ---------- State ----------
let shuttingDown = false;
let worker: WorkerLike | undefined;

let healthServer: http.Server | undefined;

// ---------- Health Server ----------
function startHealthServer() {
  healthServer = http.createServer((_req, res) => {
    // super tiny /healthz and /readyz
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    const up = !shuttingDown && !!worker;
    const body = JSON.stringify({
      service: SERVICE_NAME,
      status: up ? 'ok' : 'stopping',
      uptimeSec: Math.round((Date.now() - START_TS) / 1000),
      shuttingDown,
      concurrency: CONCURRENCY,
    });
    res.statusCode = up ? 200 : 503;
    res.end(body);
  });

  healthServer.listen(HEALTH_PORT, () => {
    logger.info({ port: HEALTH_PORT, service: SERVICE_NAME }, 'health server listening');
  });

  healthServer.on('error', (err) => {
    logger.error({ err, service: SERVICE_NAME }, 'health server error');
  });
}

// ---------- Graceful Shutdown ----------
async function shutdown(signal: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection') {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ signal, service: SERVICE_NAME }, 'shutdown initiated');

  const deadline = setTimeout(() => {
    logger.fatal(
      { service: SERVICE_NAME, timeoutMs: SHUTDOWN_DEADLINE_MS },
      'forced shutdown after deadline',
    );

    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();

  try {
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
      logger.info({ service: SERVICE_NAME }, 'health server closed');
    }
  } catch (err) {
    logger.error({ err, service: SERVICE_NAME }, 'error closing health server');
  }

  try {
    if (worker) {
      logger.info({ service: SERVICE_NAME }, 'closing worker (draining jobs) …');
      await worker.close();
      logger.info({ service: SERVICE_NAME }, 'worker closed');
    }
  } catch (err) {
    logger.error({ err, service: SERVICE_NAME }, 'error closing worker');
  }

  try {
    await shutdownTracing();
    logger.info({ service: SERVICE_NAME }, 'tracing shut down');
  } catch (err) {
    logger.warn({ err, service: SERVICE_NAME }, 'tracing shutdown error');
  }

  clearTimeout(deadline);
  logger.info({ service: SERVICE_NAME }, 'shutdown complete, exiting');

  process.exit(0);
}

let heartbeatCounter: Counter | undefined;
let jobsStartedCounter: Counter | undefined;
let jobsCompletedCounter: Counter | undefined;
let jobsFailedCounter: Counter | undefined;

type WorkerJob = {
  id?: string;
  name?: string;
  data?: unknown;
};

// ---------- Bootstrap ----------
async function main() {
  // Attach top-level diagnostics early
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err, service: SERVICE_NAME }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason, service: SERVICE_NAME }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });

  // Observability
  try {
    initTracing();
    logger.info({ service: SERVICE_NAME }, 'tracing initialized');
  } catch (err) {
    logger.warn({ err, service: SERVICE_NAME }, 'failed to init tracing, continuing');
  }

  try {
    metrics.init();
    const meter = metrics.getMeter(SERVICE_NAME);
    heartbeatCounter = meter.createCounter('worker_heartbeat_total', {
      description: 'Heartbeat emitted by the image processor worker',
    });
    jobsStartedCounter = meter.createCounter('image_jobs_started_total', {
      description: 'Image processing jobs started',
    });
    jobsCompletedCounter = meter.createCounter('image_jobs_completed_total', {
      description: 'Image processing jobs completed successfully',
    });
    jobsFailedCounter = meter.createCounter('image_jobs_failed_total', {
      description: 'Image processing jobs that failed',
    });
  } catch (err) {
    logger.warn({ err, service: SERVICE_NAME }, 'metrics unavailable; counters degraded to no-ops');
  }

  // Metrics heartbeat
  const heartbeat = setInterval(() => {
    heartbeatCounter?.add(1, { service: SERVICE_NAME });
  }, 15_000);
  heartbeat.unref();

  // Health endpoint
  startHealthServer();

  // Start worker
  logger.info(
    { service: SERVICE_NAME, concurrency: CONCURRENCY, env: env?.NODE_ENV },
    'starting image worker …',
  );

  const startedWorker = await startImageWorker({
    worker: { concurrency: CONCURRENCY },
  });

  worker = startedWorker as WorkerLike;

  if (!worker) {
    throw new Error('image worker failed to start');
  }

  worker.on('active', (job: WorkerJob) => {
    const jobId = job.id ?? 'unknown';
    const jobName = job.name ?? 'unknown';
    logger.info({ jobId, name: jobName, service: SERVICE_NAME }, 'job started');
    jobsStartedCounter?.add(1, { service: SERVICE_NAME });
  });

  worker.on('completed', (job: WorkerJob, result: unknown) => {
    const jobId = job.id ?? 'unknown';
    const jobName = job.name ?? 'unknown';
    logger.info({ jobId, name: jobName, service: SERVICE_NAME, result }, 'job completed');
    jobsCompletedCounter?.add(1, { service: SERVICE_NAME });
  });

  worker.on('failed', (job: WorkerJob | undefined, err: unknown) => {
    const jobId = job?.id ?? 'unknown';
    const jobName = job?.name ?? 'unknown';
    logger.error({ jobId, name: jobName, err, service: SERVICE_NAME }, 'job failed');
    jobsFailedCounter?.add(1, { service: SERVICE_NAME });
  });

  logger.info(
    { service: SERVICE_NAME, worker: worker?.name ?? 'image-worker' },
    'image worker is running',
  );
}

void main().catch((err) => {
  logger.fatal({ err, service: SERVICE_NAME }, 'fatal during worker bootstrap');

  process.exit(1);
});
