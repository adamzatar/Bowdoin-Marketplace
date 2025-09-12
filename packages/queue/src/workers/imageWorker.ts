// packages/queue/src/workers/imageWorker.ts
/**
 * Image processing worker (BullMQ).
 *
 * Responsibilities
 * - Consume jobs from the IMAGE queue (see QUEUE_NAMES in ../index).
 * - Validate payloads with the shared Zod schema.
 * - Download original from S3, process with sharp (strip EXIF, resize, convert).
 * - Upload optimized variants back to S3 with strong cache headers.
 * - (Best-effort) update DB state if an image record id is provided.
 * - Emit rich logs/metrics/spans and handle retries/backoff gracefully.
 *
 * Notes
 * - This file does *not* register the queue; it only runs the Worker.
 * - A small runner (e.g. apps/web/worker/image-processor.ts) should call startImageWorker().
 * - All I/O dependencies (S3, Prisma, Redis) are imported via internal packages.
 */


import path from 'node:path';
import { performance } from 'node:perf_hooks';


import { env } from '@bowdoin/config/env';
import { logger as baseLogger } from '@bowdoin/observability/logger';
import { metrics } from '@bowdoin/observability/metrics';
import { startSpan } from '@bowdoin/observability/tracing';

import { Worker, QueueEvents, type Processor, type Job } from 'bullmq';
import sharp from 'sharp';
import { z } from 'zod';


import { getQueueConnection } from '../connection';
import {
  ImageJobNames,
  type ProcessImagePayload,
  ProcessImagePayloadSchema,
} from '../jobs/imageProcessing';
import type { JobsOptions} from 'bullmq';


// Optional: use the shared db client if present
// (Worker tolerates absence; wrap in try/catch for monorepo bootstraps before db is ready)
let prisma: any | undefined;
try {
   
  prisma = require('@bowdoin/db').prisma;
} catch {
  // noop on purpose
}

// Optional: prefer storage helpers if implemented; fallback to direct AWS SDK later if needed.
let s3Helpers: {
  getObjectBuffer: (bucket: string, key: string) => Promise<{ buffer: Buffer; contentType?: string }>;
  putObject: (
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ) => Promise<void>;
} | null = null;
try {
   
  const s3 = require('@bowdoin/storage/src/s3');
  if (s3?.getObjectBuffer && s3?.putObject) {
    s3Helpers = {
      getObjectBuffer: s3.getObjectBuffer,
      putObject: s3.putObject,
    };
  }
} catch {
  // noop
}

// -----------------------------
// Constants & helpers
// -----------------------------
const log = baseLogger.child({ svc: 'image-worker' });
const QUEUE_NAME = 'image'; // must match QUEUE_NAMES.IMAGE in ../index

const DEFAULT_CONCURRENCY = Number(env.IMAGE_WORKER_CONCURRENCY ?? 3);
const CACHE_CONTROL =
  env.S3_IMAGE_CACHE_CONTROL || 'public, max-age=31536000, immutable'; // 1y immutable

const OUTPUT_FORMAT = (env.IMAGE_OUTPUT_FORMAT ?? 'webp') as 'webp' | 'jpeg' | 'avif' | 'png';

function variantKey(originalKey: string, variantName: string, fmt: string) {
  const { dir, name } = path.parse(originalKey);
  return path.posix.join(dir, `${name}.${variantName}.${fmt}`);
}

function normalizeContentType(fmt: string): string {
  switch (fmt) {
    case 'webp':
      return 'image/webp';
    case 'jpeg':
      return 'image/jpeg';
    case 'avif':
      return 'image/avif';
    case 'png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

async function downloadOriginal(
  bucket: string,
  key: string,
): Promise<{ buffer: Buffer; contentType?: string }> {
  if (!s3Helpers) {
    throw new Error(
      'S3 helpers are not available yet. Please implement @bowdoin/storage/src/s3 getObjectBuffer/putObject',
    );
  }
  return s3Helpers.getObjectBuffer(bucket, key);
}

async function uploadVariant(
  bucket: string,
  key: string,
  body: Buffer,
  fmt: string,
  cacheControl?: string,
) {
  if (!s3Helpers) {
    throw new Error(
      'S3 helpers are not available yet. Please implement @bowdoin/storage/src/s3 getObjectBuffer/putObject',
    );
  }
  const contentType = normalizeContentType(fmt);
  await s3Helpers.putObject(bucket, key, body, contentType, cacheControl ?? CACHE_CONTROL);
}

async function processVariant(
  input: Buffer,
  op: { name: string; width?: number; height?: number; fit?: keyof sharp.FitEnum; quality?: number },
  outFmt: 'webp' | 'jpeg' | 'avif' | 'png',
): Promise<Buffer> {
  const q = typeof op.quality === 'number' ? op.quality : 80;

  let pipeline = sharp(input, { failOnError: false, limitInputPixels: false }).rotate();

  // Strip metadata by default (privacy & smaller files)
  pipeline = pipeline.withMetadata({ icc: undefined, exif: undefined, iptc: undefined });

  if (op.width || op.height) {
    pipeline = pipeline.resize({
      width: op.width,
      height: op.height,
      fit: op.fit ?? 'cover',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    });
  }

  switch (outFmt) {
    case 'webp':
      pipeline = pipeline.webp({ quality: q, effort: 4 });
      break;
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:4:4' });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: q, effort: 4 });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
  }

  return pipeline.toBuffer();
}

// -----------------------------
// Processor
// -----------------------------
const processor: Processor<ProcessImagePayload, any> = async (job: Job<ProcessImagePayload>) => {
  const t0 = performance.now();
  const span = startSpan('image.process', {
    attributes: {
      'queue.job.id': job.id,
      'queue.job.name': job.name,
      'queue.name': QUEUE_NAME,
    },
  });

  try {
    // Validate & normalize
    const payload = ProcessImagePayloadSchema.parse(job.data);
    const bucket = payload.bucket ?? env.S3_BUCKET;
    if (!bucket) throw new Error('S3 bucket is not configured (env.S3_BUCKET)');

    const baseLog = log.child({
      jobId: job.id,
      listingId: payload.listingId,
      userId: payload.uploaderUserId,
      key: payload.originalKey,
    });

    baseLog.info({ msg: 'start image job', ops: payload.operations.map((o) => o.name) });

    // 1) Download original
    const { buffer: originalBuffer, contentType } = await downloadOriginal(
      bucket,
      payload.originalKey,
    );

    // 2) Process variants
    const results: Array<{ name: string; key: string; bytes: number }> = [];
    for (const op of payload.operations) {
      const variantFmt = op.format ?? OUTPUT_FORMAT;
      const key = variantKey(payload.originalKey, op.name, variantFmt);
      const out = await processVariant(originalBuffer, op, variantFmt);
      await uploadVariant(bucket, key, out, variantFmt, CACHE_CONTROL);
      results.push({ name: op.name, key, bytes: out.byteLength });

      metrics.counter('image_variant_uploaded_total').add(1, {
        variant: op.name,
        fmt: variantFmt,
      });
    }

    // (Optional) 3) Update DB (best-effort)
    if (prisma && payload.dbImageId) {
      try {
        await prisma.image.update({
          where: { id: payload.dbImageId },
          data: {
            processedAt: new Date(),
            processedVariants: results.map((r) => r.key),
            originalContentType: contentType ?? null,
          },
        });
      } catch (e) {
        baseLog.warn({ err: e }, 'db update failed (image record not updated)');
      }
    }

    const elapsed = Math.round(performance.now() - t0);
    metrics.counter('image_jobs_completed_total').add(1);
    metrics.histogram('image_job_duration_ms').record(elapsed);

    baseLog.info({ msg: 'image job completed', elapsedMs: elapsed, results });

    span.setAttribute('job.elapsed_ms', elapsed);
    span.end();

    return { ok: true, elapsedMs: elapsed, results };
  } catch (err) {
    metrics.counter('image_jobs_failed_total').add(1);
    log.error({ err, jobId: job.id }, 'image job failed');
    span.recordException(err as Error);
    span.end();
    throw err; // let BullMQ handle retry/backoff
  }
};

// -----------------------------
// Worker bootstrap
// -----------------------------
export function startImageWorker(options?: {
  concurrency?: number;
  jobsOptions?: JobsOptions;
}) {
  const connection = getQueueConnection(); // ioredis instance from ../connection
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;

  const worker = new Worker<ProcessImagePayload>(QUEUE_NAME, processor, {
    connection,
    concurrency,
    // Important for large images; let sharp do file I/O and avoid freezing event loop
    // BullMQ uses separate workers per concurrency anyway.
  });

  const events = new QueueEvents(QUEUE_NAME, { connection });

  events.on('completed', ({ jobId }) => {
    log.debug({ jobId }, 'job completed');
  });
  events.on('failed', ({ jobId, failedReason }) => {
    log.warn({ jobId, failedReason }, 'job failed');
  });

  worker.on('error', (err) => {
    log.error({ err }, 'worker error');
  });

  log.info(
    { queue: QUEUE_NAME, concurrency },
    'image worker started (listening for processing jobs)',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down image worker...');
    try {
      await Promise.allSettled([worker.close(), events.close()]);
      if (typeof (connection as any)?.quit === 'function') {
        await (connection as any).quit();
      }
      log.info('image worker shut down cleanly');
      // Do not call process.exit here; the host runner should decide.
    } catch (e) {
      log.error({ err: e }, 'error during worker shutdown');
    }
  };

  // Graceful shutdown hooks (idempotent)
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  return { worker, events, shutdown };
}