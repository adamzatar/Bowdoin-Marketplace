// packages/observability/src/logger.ts
/**
 * @module @bowdoin/observability/logger
 * Centralized pino logger with sane defaults:
 * - JSON logs in production, pretty logs in dev
 * - Request IDs and trace IDs support
 * - Safe redaction of secrets/PII
 */

import { env } from '@bowdoin/config/env';
import pino from 'pino';

import type { LoggerOptions, Logger } from 'pino';

const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

// env.LOG_LEVEL may not be in the Env type; read defensively
const configuredLevel =
  (env as unknown as Record<string, unknown>)['LOG_LEVEL'] ??
  (isProd ? 'info' : 'debug');

const redact: string[] = [
  'password',
  'authorization',
  'cookie',
  'refreshToken',
  '*.secret',
  '*.token',
];

const baseOptions: LoggerOptions = {
  // pino expects string levels
  level: String(configuredLevel),
  redact,
  // exactOptionalPropertyTypes: use null, not undefined
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
};

const transport = !isProd && !isTest
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger: Logger = pino({
  ...baseOptions,
  // under exactOptionalPropertyTypes, only add when defined
  ...(transport ? { transport } : {}),
});

/** Create a child logger with request/trace context. */
export function withContext(
  context: Record<string, string | number | boolean>,
): Logger {
  return logger.child(context);
}