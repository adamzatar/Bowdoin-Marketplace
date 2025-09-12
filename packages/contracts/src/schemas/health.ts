// packages/contracts/src/schemas/health.ts
import { z } from 'zod';

/**
 * High-level status states.
 */
export const StatusEnum = z.enum(['ok', 'degraded', 'error']);
export type Status = z.infer<typeof StatusEnum>;

/**
 * Shape of a dependency check (DB, Redis, S3, etc).
 */
export const DependencyStatusSchema = z.object({
  name: z.string().min(1),
  status: StatusEnum,
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
});
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

/**
 * /api/healthz — lightweight liveness probe.
 */
export const HealthzResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().int().nonnegative(),
});
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

/**
 * /api/readyz — readiness & dependency checks.
 */
export const ReadyzResponseSchema = z.object({
  status: StatusEnum,
  uptimeSeconds: z.number().int().nonnegative(),
  dependencies: z.array(DependencyStatusSchema),
  version: z.string().optional(), // git sha / semver
  commit: z.string().optional(), // git commit id
  buildTime: z.string().datetime().optional(),
});
export type ReadyzResponse = z.infer<typeof ReadyzResponseSchema>;

/**
 * Internal representation for system metrics (OTEL export).
 */
export const SystemMetricsSchema = z.object({
  cpuLoad: z.number().min(0).max(100).optional(),
  memoryUsageMb: z.number().nonnegative().optional(),
  openConnections: z.number().int().nonnegative().optional(),
});
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;