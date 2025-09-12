/**
 * @module @bowdoin/observability/logger
 * Centralized pino logger with sane defaults:
 * - JSON logs in production, pretty logs in dev
 * - Request IDs and trace IDs support
 * - Safe redaction of secrets/PII
 */
import type { Logger } from 'pino';
export declare const logger: Logger;
/** Create a child logger with request/trace context. */
export declare function withContext(context: Record<string, string | number | boolean>): Logger;
//# sourceMappingURL=logger.d.ts.map