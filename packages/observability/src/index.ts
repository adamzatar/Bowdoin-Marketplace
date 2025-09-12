// packages/observability/src/index.ts
/**
 * @module @bowdoin/observability
 *
 * Barrel exports for logging, metrics, tracing, and audit utilities.
 * Side-effect free: only re-exports.
 */

export * from "./logger";
export * from "./metrics";
export * from "./tracing";
export * from "./audit";

// Optional namespace for high-level audit event helpers
export * as auditEvents from './audit/events';