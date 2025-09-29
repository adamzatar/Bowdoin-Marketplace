// packages/queue/src/index.ts
import {
  connectRedis,
  disconnectRedis,
  registerQueueSignalHandlers,
  createQueue,
  createWorker,
} from './connection';
import type { WorkerFactoryOptions } from './connection';

import type {
  Queue,
  Worker,
  JobsOptions,
  Processor,
  WorkerOptions as BullWorkerOptions,
} from 'bullmq';



/**
 * Stable queue names used across the system.
 * Keep these constant to avoid orphaned keys in Redis.
 */
export const QueueNames = {
  IMAGE_PROCESSING: 'image-processing',
  EMAIL_OUTBOUND: 'email-outbound',
  // add new queues here
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

/** Public re-exports for consumers (apps/web, workers, scripts) */
export {
  connectRedis,
  disconnectRedis,
  registerQueueSignalHandlers,
  createQueue,
  createWorker,
};
export type { JobsOptions, Processor };

/**
 * --- Lazy singletons for common queues ---
 * These provide a consistent place to create and access queues/schedulers.
 * If you add a new queue, follow the same pattern.
 */
let _image: Queue<unknown> | undefined;
let _email: Queue<unknown> | undefined;

/** Default job options applied to most queues unless overridden per-job */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 24 * 60 * 60, count: 1000 },
};

/** Image processing queue (thumbnails, EXIF strip, variants, etc.) */
export function imageQueue(): Queue<unknown> {
  if (!_image) {
    _image = createQueue(QueueNames.IMAGE_PROCESSING, {
      prefix: 'bmq', // namespace in Redis
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _image!;
}

/** Outbound email queue (verification, notifications) */
export function emailQueue(): Queue<unknown> {
  if (!_email) {
    _email = createQueue(QueueNames.EMAIL_OUTBOUND, {
      prefix: 'bmq',
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTIONS,
        // Emails usually don’t need heavy retries; tune separately if needed
        attempts: 2,
        backoff: { type: 'fixed', delay: 1500 },
      },
    });
  }
  return _email!;
}

/**
 * --- Worker helpers ---
 * These wire up workers with consistent defaults & graceful shutdown.
 * Provide your own processor functions where you enqueue jobs.
 */

export type StartWorkerOptions = {
  /**
   * Concurrency per worker instance; defaults to env.WORKER_CONCURRENCY (handled in connection.ts) or 4.
   */
  concurrency?: number;
  /**
   * Enable additional log noise for lifecycle events (active/stalled).
   */
  verboseMetrics?: boolean;
  /**
   * Optional BullMQ Worker options passthrough (rarely needed).
   */
  workerOptions?: Omit<BullWorkerOptions, 'connection' | 'concurrency' | 'prefix'>;
};

/** Start the outbound email worker */
export function startEmailWorker<T = unknown, R = unknown>(
  processor: Processor<T, R>,
  opts: StartWorkerOptions = {},
): Worker<T, R> {
  const workerOpts: WorkerFactoryOptions = {
    metrics: !!opts.verboseMetrics,
    prefix: 'bmq',
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  };

  const w = createWorker<T, R>(QueueNames.EMAIL_OUTBOUND, processor, workerOpts);

  registerQueueSignalHandlers();
  return w;
}

/**
 * Convenience to initialize all known queues (e.g., at app boot) so their
 * schedulers are live and delayed/retried jobs are processed on time.
 */
export async function initQueues(): Promise<void> {
  await connectRedis();
  imageQueue();
  emailQueue();
}

/**
 * Convenience to add common jobs with minimal boilerplate.
 * These are intentionally generic; feature packages should define their own
 * strongly-typed helpers (e.g., `enqueueListingImageVariants({...})`) that call these.
 */

export async function enqueueImageJob<T extends Record<string, unknown>>(
  name: string,
  payload: T,
  opts?: JobsOptions,
) {
  const queue = imageQueue();
  return queue.add(name, payload as unknown, opts);
}

export async function enqueueEmailJob<T extends Record<string, unknown>>(
  name: string,
  payload: T,
  opts?: JobsOptions,
) {
  const queue = emailQueue();
  return queue.add(name, payload as unknown, opts);
}

/**
 * Barrel re-exports for job/worker modules so consumers can import from '@bowdoin/queue'
 * without deep paths once those modules are implemented with concrete types.
 * (Safe even if the files are currently minimal.)
 */
export * from './jobs/imageProcessing';
export * from './jobs/send-email-verification';
export { startImageWorker } from './workers/imageWorker';
