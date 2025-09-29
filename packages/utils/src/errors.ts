/**
 * @module @bowdoin/utils/errors
 * Centralized error primitives for API, workers, and UI-boundary mapping.
 * - Typed AppError with stable codes
 * - Result<T, E> helpers for functional flows
 * - Safe serialization and HTTP mapping
 * - Minimal and dependency-free
 */

export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

export interface AppErrorOptions {
  /** HTTP status override; inferred from code if omitted */
  status?: number;
  /** Arbitrary, non-sensitive structured data (e.g., validation field errors) */
  details?: unknown;
  /** If true, message is safe to show to end users */
  expose?: boolean;
  /** Underlying cause (not serialized unless safe) */
  cause?: unknown;
}

/**
 * Canonical application error with stable `code` and safe serialization.
 */
export class AppError extends Error {
  override name = 'AppError';
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(code: AppErrorCode, message: string, opts: AppErrorOptions = {}) {
    // Pass cause to the base Error so `err.cause` is standard-compliant
    super(message, { cause: opts.cause });

    // Maintains proper prototype chain in TS when targeting ES2019+
    Object.setPrototypeOf(this, new.target.prototype);

    this.code = code;
    this.status = opts.status ?? codeToHttpStatus(code);
    this.details = opts.details;
    this.expose = opts.expose ?? defaultExpose(code);

    // Better stacks in Node
    if (captureStackTrace) {
      captureStackTrace(this, AppError);
    }
  }
}

type StackConstructor = abstract new (...args: unknown[]) => unknown;
type CaptureStackTrace = (error: Error, constructorOpt?: StackConstructor) => void;

function resolveCaptureStackTrace(): CaptureStackTrace | undefined {
  const maybe = (Error as { captureStackTrace?: CaptureStackTrace }).captureStackTrace;
  return typeof maybe === 'function' ? maybe : undefined;
}

const captureStackTrace = resolveCaptureStackTrace();

/** Map canonical codes to HTTP status. */
export function codeToHttpStatus(code: AppErrorCode): number {
  switch (code) {
    case 'BAD_REQUEST':
    case 'VALIDATION':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'UNAVAILABLE':
      return 503;
    case 'NOT_IMPLEMENTED':
      return 501;
    case 'INTERNAL':
    default:
      return 500;
  }
}

/** Default exposure policy: only some codes are safe to surface to end users. */
function defaultExpose(code: AppErrorCode): boolean {
  return (
    code === 'BAD_REQUEST' ||
    code === 'VALIDATION' ||
    code === 'NOT_FOUND' ||
    code === 'RATE_LIMITED' ||
    code === 'NOT_IMPLEMENTED'
  );
}

/** Type guard. */
export function isAppError(e: unknown): e is AppError {
  return isRecord(e) && e.name === 'AppError' && 'code' in e;
}

/**
 * Normalize unknown errors into AppError. Useful in catch-all boundaries.
 * @example
 * try { ... } catch (e) { throw toAppError(e, 'INTERNAL') }
 */
export function toAppError(e: unknown, fallback: AppErrorCode = 'INTERNAL'): AppError {
  if (isAppError(e)) return e;

  const message = extractMessage(e) ?? 'Unexpected error';

  return new AppError(fallback, message, { cause: e, expose: fallback !== 'INTERNAL' });
}

function extractMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Shape used for HTTP JSON error payloads. */
export interface ErrorBody {
  error: {
    code: AppErrorCode;
    message: string;
    details?: unknown;
    // requestId, traceId can be merged by the HTTP layer
  };
}

/**
 * Serialize an AppError to a safe JSON payload for HTTP responses.
 * Strips stack/cause and only includes `details` if the error is exposable.
 */
export function toErrorBody(err: AppError | unknown): ErrorBody {
  const e = isAppError(err) ? err : toAppError(err, 'INTERNAL');
  const message = e.expose ? e.message : statusText(e.status);
  return {
    error: {
      code: e.code,
      message,
      details: e.expose ? redact(e.details) : undefined,
    },
  };
}

/** Minimal status text fallback. */
function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 429:
      return 'Too Many Requests';
    case 501:
      return 'Not Implemented';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Internal Server Error';
  }
}

/** Generic Result type for functional flows. */
export type Ok<T> = { ok: true; value: T };
export type Err<E = AppError> = { ok: false; error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}
export function err<E = AppError>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Run an async function and capture errors as Result.
 * @example
 * const res = await safe(async () => await repo.create(data));
 * if (!res.ok) return handle(res.error);
 */
export async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toAppError(e));
  }
}

/** Assertion that throws AppError on failure (better than raw `assert`). */
export function assert(
  condition: unknown,
  code: AppErrorCode,
  message: string,
  opts?: AppErrorOptions,
): asserts condition {
  if (!condition) throw new AppError(code, message, opts);
}

/** Domain-friendly invariant helper mapped to INTERNAL errors. */
export function invariant(condition: unknown, message = 'Invariant violated'): asserts condition {
  if (!condition) throw new AppError('INTERNAL', message);
}

/**
 * Redact common sensitive keys from a plain object/array. No-op for primitives/undefined.
 * Non-recursive by default (deep = false) for performance; enable as needed.
 */
export function redact<T>(input: T, deep = false): T {
  if (!input || typeof input !== 'object') return input;

  const SENSITIVE = new Set([
    'password',
    'pass',
    'secret',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'apiKey',
    'clientSecret',
    'privateKey',
    'cookie',
    'setCookie',
  ]);

  if (Array.isArray(input)) {
    return (deep ? input.map((v) => redact(v, true)) : input.slice()) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE.has(k)) {
      out[k] = '[REDACTED]';
    } else if (deep && typeof v === 'object' && v !== null) {
      out[k] = redact(v, true);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Convert a typical schema/validation error (e.g., Zod-like) to AppError.
 * Avoids a hard dep on zod by duck-typing { issues?: Array<{ path?: (string|number)[], message: string }> }.
 */
export function toValidationError(
  message: string,
  issues?: Array<{ path?: Array<string | number>; message: string }>,
): AppError {
  const details =
    issues && issues.length
      ? issues.map((i) => ({
          path: i.path?.join('.') ?? '',
          message: i.message,
        }))
      : undefined;
  return new AppError('VALIDATION', message, { details, expose: true });
}

/**
 * Narrow a thrown error into HTTP pieces (status + body) for route handlers.
 * @example
 * const { status, body } = asHttp(e); return new Response(JSON.stringify(body), { status })
 */
export function asHttp(e: unknown): { status: number; body: ErrorBody } {
  const app = toAppError(e);
  return { status: app.status, body: toErrorBody(app) };
}

/**
 * Create a namespaced error factory for a subsystem.
 * @example
 * const authErr = makeErrorFactory('auth');
 * throw authErr('UNAUTHORIZED', 'Session expired', { expose: true });
 */
export function makeErrorFactory(namespace: string) {
  return (code: AppErrorCode, message: string, opts?: AppErrorOptions) =>
    new AppError(code, `[${namespace}] ${message}`, opts);
}
