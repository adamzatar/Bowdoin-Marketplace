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
// - @bowdoin/queue/workers exports `createImageWorker(opts?)`
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
import { createImageWorker } from '@bowdoin/queue/workers';

// ---------- Config ----------
const SERVICE_NAME = 'image-processor';
const START_TS = Date.now();

const HEALTH_PORT = Number(process.env.IMAGE_WORKER_HEALTH_PORT ?? process.env.PORT ?? 8081);
const CONCURRENCY = Number(process.env.IMAGE_WORKER_CONCURRENCY ?? env?.WORKER_CONCURRENCY ?? 4);

// how long to wait for graceful shutdown before forcing exit
const SHUTDOWN_DEADLINE_MS = Number(process.env.IMAGE_WORKER_SHUTDOWN_DEADLINE_MS ?? 25_000);

// ---------- State ----------
let shuttingDown = false;
let worker: { name?: string; close: () => Promise<void> } | undefined;

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
    await initTracing({ serviceName: SERVICE_NAME });
    logger.info({ service: SERVICE_NAME }, 'tracing initialized');
  } catch (err) {
    logger.warn({ err, service: SERVICE_NAME }, 'failed to init tracing, continuing');
  }

  // Metrics heartbeat
  const heartbeat = setInterval(() => {
    try {
      metrics
        .counter('worker_heartbeat_total', {
          service: SERVICE_NAME,
        })
        .add(1);
    } catch {
      // best-effort
    }
  }, 15_000);
  heartbeat.unref();

  // Health endpoint
  startHealthServer();

  // Start worker
  logger.info(
    { service: SERVICE_NAME, concurrency: CONCURRENCY, env: env?.NODE_ENV },
    'starting image worker …',
  );

  worker = await createImageWorker({
    concurrency: CONCURRENCY,
    // You can pass additional hooks if your worker supports them
    onActive(job) {
      logger.info({ jobId: job.id, name: job.name, service: SERVICE_NAME }, 'job started');
      try {
        metrics.counter('image_jobs_started_total').add(1);
      } catch (_err) {
        // no-op: metrics failures are non-fatal for worker progress
      }
    },
    onCompleted(job, _result) {
      logger.info({ jobId: job.id, name: job.name, service: SERVICE_NAME }, 'job completed');
      try {
        metrics.counter('image_jobs_completed_total').add(1);
      } catch (_err) {
        // no-op: metrics failures are non-fatal for worker progress
      }
    },
    onFailed(job, err) {
      logger.error({ jobId: job?.id, name: job?.name, err, service: SERVICE_NAME }, 'job failed');
      try {
        metrics.counter('image_jobs_failed_total').add(1);
      } catch (_err) {
        // no-op: metrics failures are non-fatal for worker progress
      }
    },
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
