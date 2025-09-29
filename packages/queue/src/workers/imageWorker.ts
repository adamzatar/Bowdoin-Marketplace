/* eslint-disable import/no-extraneous-dependencies */

import { Worker, type Processor, type WorkerOptions, type JobsOptions } from "bullmq";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import sharp, { type FitEnum, type FormatEnum } from "sharp";
import { logger } from "@bowdoin/observability/logger";
import { metrics } from "@bowdoin/observability/metrics";

// ------------------------------ types ------------------------------

export type Variant = {
  name: string;
  width: number;
  height?: number;
  withoutEnlargement: boolean;
  fit?: keyof FitEnum;
  format?: keyof FormatEnum; // falls back to IMAGE_OUTPUT_FORMAT if omitted
};

export type ImageJobData = {
  // business context
  listingId: string;
  uploaderUserId: string;

  // storage & keys
  bucket: string;
  keyOriginal: string; // canonical
  /** legacy alias some producers might still send; we normalize to keyOriginal */
  originalKey?: string;
  outputPrefix: string;

  // processing
  stripExif: boolean;
  overwrite: boolean;
  variants: Variant[];

  // hints
  originalContentType?:
    | "image/webp"
    | "image/jpeg"
    | "image/png"
    | "image/avif"
    | "image/heic"
    | "image/heif";

  // optional bookkeeping fields some producers may attach
  dbImageId?: string;
  operations?: string[];
};

export type ImageJobResult = {
  bucket: string;
  outputs: Array<{
    key: string;
    contentType: string;
    width: number;
    height?: number;
    format: string;
    bytes: number;
  }>;
};

// ------------------------------ env / config ------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const S3_ENDPOINT = process.env.S3_ENDPOINT; // optional (LocalStack/MinIO)
const S3_FORCE_PATH_STYLE =
  String(process.env.S3_FORCE_PATH_STYLE ?? "").toLowerCase() === "true";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

const IMAGE_WORKER_CONCURRENCY = Number(process.env.IMAGE_WORKER_CONCURRENCY ?? "4");
const S3_IMAGE_CACHE_CONTROL =
  process.env.S3_IMAGE_CACHE_CONTROL ?? "public, max-age=31536000, immutable";
const IMAGE_OUTPUT_FORMAT = (process.env.IMAGE_OUTPUT_FORMAT ?? "webp").toLowerCase() as
  | "webp"
  | "jpeg"
  | "png"
  | "avif";

// Use caller-provided connection if available; otherwise BullMQ will use REDIS_URL
export type StartWorkerOptions = {
  /** BullMQ worker options (you can inject a shared ioredis connection here) */
  worker?: Omit<WorkerOptions, "concurrency"> & { concurrency?: number };
  /** name of the queue to consume (default: "image.process") */
  queueName?: string;
  /** default job options (retries, etc.) */
  defaultJobOptions?: JobsOptions;
};

// ------------------------------ s3 helpers ------------------------------

const region: string = process.env.AWS_REGION ?? S3_REGION;

const s3Config: S3ClientConfig = {
  region,
  ...(S3_ENDPOINT ? { endpoint: S3_ENDPOINT } : {}),
  ...(S3_FORCE_PATH_STYLE ? { forcePathStyle: true } : {}),
  ...(S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: S3_ACCESS_KEY_ID,
          secretAccessKey: S3_SECRET_ACCESS_KEY,
        },
      }
    : {}),
};

const s3 = new S3Client(s3Config);

async function getObjectAsBuffer(bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body;
  if (!body) throw new Error(`S3 GET returned no Body for s3://${bucket}/${key}`);
  if (Buffer.isBuffer(body)) return body;
  // Body is a stream in Node – collect into a buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function headExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function putObjectBuffer(params: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}): Promise<number> {
  await s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      CacheControl: params.cacheControl ?? S3_IMAGE_CACHE_CONTROL,
    }),
  );
  // S3 doesn't return size; use buffer length
  return params.body.length;
}

// ------------------------------ processing ------------------------------

function variantKey(prefix: string, v: Variant, format: string): string {
  const parts = [prefix.replace(/\/+$/, ""), `${v.name}@${v.width}${v.height ? "x" + v.height : ""}`];
  return `${parts.join("/")}.${format}`;
}

function normalizeData(data: ImageJobData): ImageJobData {
  if (!data.keyOriginal && data.originalKey) {
    data.keyOriginal = data.originalKey;
  }
  return data;
}

function contentTypeFor(format: string): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "avif":
      return "image/avif";
    case "webp":
    default:
      return "image/webp";
  }
}

async function processOneVariant(
  source: Buffer,
  v: Variant,
  stripExif: boolean,
  fallbackFormat: string,
): Promise<{ buffer: Buffer; width: number; height?: number; format: string; contentType: string }> {
  const format = (v.format ?? fallbackFormat) as string;

  let pipeline = sharp(source, { failOn: "none" });

  if (stripExif) {
    // Keep metadata minimal; do not inject unsupported keys
    pipeline = pipeline.withMetadata({});
  }

  pipeline = pipeline.resize({
    width: v.width,
    height: v.height,
    fit: v.fit ?? "cover",
    withoutEnlargement: v.withoutEnlargement,
  });

  switch (format) {
    case "jpeg":
      pipeline = pipeline.jpeg({ quality: 80, chromaSubsampling: "4:4:4" });
      break;
    case "png":
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    case "avif":
      pipeline = pipeline.avif({ quality: 50 });
      break;
    case "webp":
    default:
      pipeline = pipeline.webp({ quality: 80 });
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    width: info.width ?? v.width,
    height: info.height,
    format,
    contentType: contentTypeFor(format),
  };
}

// ------------------------------ job processor ------------------------------

const processor: Processor<ImageJobData, ImageJobResult> = async (job) => {
  const t0 = Date.now();
  const data = normalizeData(job.data);

  const { bucket, keyOriginal, outputPrefix, stripExif, overwrite, variants } = data;

  logger.info(
    {
      jobId: job.id,
      listingId: data.listingId,
      keyOriginal,
      variants: variants.map((v) => v.name),
    },
    "imageWorker: start",
  );

  const src = await getObjectAsBuffer(bucket, keyOriginal);

  const outputs: ImageJobResult["outputs"] = [];

  for (const v of variants) {
    const fmt = (v.format ?? IMAGE_OUTPUT_FORMAT).toLowerCase();
    const key = variantKey(outputPrefix, v, fmt);

    if (!overwrite) {
      const exists = await headExists(bucket, key);
      if (exists) {
        logger.debug({ key }, "imageWorker: skip existing object");
        continue;
      }
    }

    const out = await processOneVariant(src, v, stripExif, IMAGE_OUTPUT_FORMAT);
    const bytes = await putObjectBuffer({
      bucket,
      key,
      body: out.buffer,
      contentType: out.contentType,
      cacheControl: S3_IMAGE_CACHE_CONTROL,
    });

    outputs.push({
      key,
      contentType: out.contentType,
      width: out.width,
      ...(out.height !== undefined ? { height: out.height } : {}),
      format: out.format,
      bytes,
    });
  }

  const dt = Date.now() - t0;
  metrics.recordHttp(dt, { worker: "image" });

  logger.info({ jobId: job.id, outputsCount: outputs.length, ms: dt }, "imageWorker: done");

  return { bucket, outputs };
};

// ------------------------------ start API ------------------------------

/**
 * Start the image worker.
 * - Pass `opts.worker.connection` to reuse a shared Redis connection.
 * - Override `opts.queueName` if your queue name differs (default "image.process").
 */
export function startImageWorker(
  opts: StartWorkerOptions = {},
): Worker<ImageJobData, ImageJobResult> {
  const queueName = opts.queueName ?? "image.process";

  const worker = new Worker<ImageJobData, ImageJobResult>(queueName, processor, {
    concurrency: opts.worker?.concurrency ?? IMAGE_WORKER_CONCURRENCY,
    // If caller provided a connection use it; otherwise construct from REDIS_URL
    connection:
      opts.worker?.connection ??
      ({
        url: REDIS_URL,
      } as unknown as WorkerOptions["connection"]),
    // carry through any other worker options the caller passed
    ...(opts.worker ?? {}),
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err?.message, stack: err?.stack },
      "imageWorker: job failed",
    );
    metrics.counters.httpRequestErrors.add(1, { worker: "image" });
  });

  worker.on("completed", (job, result) => {
    logger.debug({ jobId: job.id, outputs: result?.outputs?.length ?? 0 }, "imageWorker: completed");
  });

  logger.info(
    { queueName, concurrency: worker.opts.concurrency, redisUrl: REDIS_URL },
    "imageWorker: started",
  );

  return worker;
}

export default startImageWorker;
