// packages/observability/src/audit.ts
/**
 * @module @bowdoin/observability/audit
 * Strongly-typed, privacy-aware audit logging with pluggable sinks.
 */

import { createHash, randomUUID, type BinaryLike } from 'node:crypto';
import process from 'node:process';

import { logger } from './logger';

/* ───────────────────────────── Types & constants ───────────────────────────── */

type ISO8601 = string;

export const AuditAction = {
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_SESSION_CREATED: 'auth.session.created',
  AUTH_SESSION_REVOKED: 'auth.session.revoked',

  USER_CREATED: 'user.created',
  USER_ROLE_CHANGED: 'user.role.changed',
  USER_AFFILIATION_REQUESTED: 'user.affiliation.requested',
  USER_AFFILIATION_VERIFIED: 'user.affiliation.verified',
  USER_AFFILIATION_REJECTED: 'user.affiliation.rejected',

  LISTING_CREATED: 'listing.created',
  LISTING_UPDATED: 'listing.updated',
  LISTING_DELETED: 'listing.deleted',
  LISTING_MARKED_SOLD: 'listing.marked_sold',

  MESSAGE_SENT: 'message.sent',
  THREAD_CREATED: 'thread.created',

  REPORT_FILED: 'report.filed',
  REPORT_ACTIONED: 'report.actioned',
  ADMIN_USER_BANNED: 'admin.user.banned',
  ADMIN_LISTING_REMOVED: 'admin.listing.removed',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction] | (string & {});
export type Realm = 'bowdoin' | 'community';
export type Role = 'student' | 'staff' | 'admin' | 'guest';

export interface AuditActor {
  id?: string;
  role?: Role;
  realm?: Realm;
  email?: string; // will be hashed
}

export interface AuditTarget {
  type: 'user' | 'listing' | 'thread' | 'message' | 'report' | 'storage' | 'system' | (string & {});
  id?: string;
  ownerId?: string;
}

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditRequestContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  route?: string; // e.g., "POST /api/listings"
}

export interface AuditTraceContext {
  traceId?: string;
  spanId?: string;
}

export interface AuditEvent {
  ts: ISO8601;
  id: string;

  action: AuditActionValue;
  outcome: AuditOutcome;

  actor?: AuditActor;
  target?: AuditTarget;
  resource?: string;

  req?: AuditRequestContext;
  trace?: AuditTraceContext;

  severity?: 'info' | 'warn' | 'error';
  meta?: Record<string, unknown>;
}

/* ───────────────────────────── Sink plumbing ───────────────────────────── */

export type AuditSink = (event: Readonly<AuditEvent>) => void | Promise<void>;
const sinks: AuditSink[] = [];

/** Default pino sink (level mapping is explicit to avoid `any`). */
const pinoSink: AuditSink = (evt) => {
  const level: 'info' | 'warn' | 'error' =
    evt.severity ?? (evt.outcome === 'failure' || evt.outcome === 'denied' ? 'warn' : 'info');

  // Maintain a compact, structured log
  if (level === 'error') {
    logger.error({ audit: true, ...evt });
  } else if (level === 'warn') {
    logger.warn({ audit: true, ...evt });
  } else {
    logger.info({ audit: true, ...evt });
  }
};

registerSink(pinoSink);

export function registerSink(sink: AuditSink): void {
  sinks.push(sink);
}

export function clearSinks(): void {
  sinks.length = 0;
  sinks.push(pinoSink);
}

/* ───────────────────────────── Emitters ───────────────────────────── */

/**
 * Emit a privacy-aware audit event.
 * Omits optional keys when not provided (friendly to exactOptionalPropertyTypes).
 */
export async function emit(
  action: AuditActionValue,
  details: Partial<Omit<AuditEvent, 'ts' | 'id' | 'action'>> & { ts?: ISO8601; id?: string } = {},
): Promise<void> {
  const base: AuditEvent = {
    id: details.id ?? randomUUID(),
    ts: details.ts ?? new Date().toISOString(),
    action,
    outcome: details.outcome ?? 'success',
  };

  if (details.actor) base.actor = redactActor(details.actor);
  if (details.target) base.target = details.target;
  if (details.resource) base.resource = details.resource;

  const req = normalizeReq(details.req);
  if (req) base.req = req;

  if (details.trace) base.trace = details.trace;
  if (details.severity) base.severity = details.severity;

  if (details.meta) {
    const redacted = deepRedact(details.meta);
    base.meta = typeof redacted === 'object' && redacted ? (redacted as Record<string, unknown>) : {};
  }

  const safe = clampSizes(base);

  await Promise.all(
    sinks.map(async (s) => {
      try {
        await s(safe);
      } catch (err) {
        logger.warn({ err }, 'Audit sink failed');
      }
    }),
  );
}

/** Fire-and-forget wrapper (never throws). */
export async function captureAuditEvent(
  action: AuditActionValue,
  details?: Partial<Omit<AuditEvent, 'ts' | 'id' | 'action'>>,
): Promise<void> {
  try {
    await emit(action, details ? { ...details } : {});
  } catch (err) {
    logger.debug({ err }, 'captureAuditEvent: failed (ignored)');
  }
}

/** Partially-applied emitter for a fixed action. */
export function createActionEmitter(
  action: AuditActionValue,
  base?: Partial<Omit<AuditEvent, 'action' | 'id' | 'ts'>>,
) {
  return (details?: Partial<Omit<AuditEvent, 'action' | 'id' | 'ts'>>) =>
    emit(action, { ...(base ?? {}), ...(details ?? {}) });
}

/* ───────────────────────────── OTLP Logs (optional) ───────────────────────────── */

function getEnv(key: string): string | undefined {
  const v = process?.env?.[key];
  return v && String(v).trim() ? String(v).trim() : undefined;
}

const OTLP_LOGS_ENDPOINT = getEnv('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT') ?? getEnv('OTEL_EXPORTER_OTLP_ENDPOINT');

if (OTLP_LOGS_ENDPOINT) {
  try {
    const endpoint = new URL(OTLP_LOGS_ENDPOINT);
    const serviceName = getEnv('OTEL_SERVICE_NAME') ?? process.env.npm_package_name ?? 'bowdoin-marketplace';

    registerSink(async (evt) => {
      const body = {
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: String(serviceName) } },
                { key: 'deployment.environment', value: { stringValue: getEnv('NODE_ENV') ?? 'development' } },
              ],
            },
            scopeLogs: [
              {
                scope: { name: '@bowdoin/observability/audit' },
                logRecords: [
                  {
                    timeUnixNano: BigInt(Date.now()) * BigInt(1_000_000),
                    severityText: (evt.severity ?? 'info').toUpperCase(),
                    body: { stringValue: JSON.stringify(evt) },
                    attributes: [
                      { key: 'audit.action', value: { stringValue: String(evt.action) } },
                      { key: 'audit.outcome', value: { stringValue: String(evt.outcome) } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const headersStr = getEnv('OTEL_EXPORTER_OTLP_HEADERS');
      const extraHeaders = headersStr ? safeJson(headersStr) : undefined;

      const f = globalThis.fetch?.bind(globalThis);
      if (!f) {
        logger.debug('Global fetch not available; skipping OTLP audit sink send');
        return;
      }

      await f(endpoint.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      }).catch((err) => logger.debug({ err }, 'OTLP logs export failed (non-fatal)'));
    });

    logger.info({ endpoint: endpoint.toString() }, 'OTLP audit log sink enabled');
  } catch {
    logger.warn('Invalid OTLP logs endpoint; skipping OTLP audit sink');
  }
}

function safeJson(maybeJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(maybeJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/* ───────────────────────────── Utilities ───────────────────────────── */

function redactActor(actor: AuditActor): AuditActor {
  const out: AuditActor = { ...actor };
  if (out.email) out.email = hashEmail(out.email);
  return out;
}

function hashEmail(email: string): string {
  try {
    const [local, domain] = String(email).toLowerCase().split('@');
    const input: BinaryLike = local ?? '';
    const h = createHash('sha256').update(input).digest('hex').slice(0, 16);
    return `${h}@${domain ?? 'redacted'}`;
  } catch {
    return 'redacted@redacted';
  }
}

const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  'set-cookie',
  'apiKey',
  'x-api-key',
]);

function deepRedact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => deepRedact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const low = k.toLowerCase();
    if (SENSITIVE_KEYS.has(low) || low.includes('secret')) {
      out[k] = '[redacted]';
    } else if (low.includes('email') && typeof v === 'string') {
      out[k] = hashEmail(v);
    } else {
      out[k] = deepRedact(v, seen);
    }
  }
  return out;
}

function normalizeReq(req?: AuditRequestContext): AuditRequestContext | undefined {
  if (!req) return undefined;
  const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  const out: AuditRequestContext = {};
  if (req.userAgent) out.userAgent = truncate(req.userAgent, 256);
  if (req.ip) out.ip = truncate(req.ip, 64);
  if (req.route) out.route = truncate(req.route, 128);
  if (req.requestId) out.requestId = truncate(req.requestId, 128);
  return Object.keys(out).length ? out : undefined;
}

function clampSizes(evt: AuditEvent): AuditEvent {
  const clone: AuditEvent = JSON.parse(JSON.stringify(evt));
  if (clone.meta) {
    const str = JSON.stringify(clone.meta);
    if (str.length > 16_000) {
      clone.meta = { notice: 'meta_truncated', bytes: str.length };
    }
  }
  return clone;
}

/* ───────────────────────────── High-level helpers ───────────────────────────── */

export async function emitAffiliationEvent(params: {
  userId: string;
  from?: Realm;
  to?: Realm;
  verified?: boolean;
  reason?: string;
  actor?: AuditActor;
  req?: AuditRequestContext;
}) {
  const action =
    params.verified
      ? AuditAction.USER_AFFILIATION_VERIFIED
      : params.reason
        ? AuditAction.USER_AFFILIATION_REJECTED
        : AuditAction.USER_AFFILIATION_REQUESTED;

  const details: Partial<Omit<AuditEvent, 'ts' | 'id' | 'action'>> = {
    outcome: action === AuditAction.USER_AFFILIATION_REJECTED ? 'failure' : 'success',
    target: { type: 'user', id: params.userId },
    meta: {
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
  };

  if (params.actor) details.actor = params.actor;
  if (params.req) details.req = params.req;

  return emit(action, details);
}

/* ───────────────────────────── Public facade ───────────────────────────── */

export const audit = {
  emit,
  capture: captureAuditEvent,
  createActionEmitter,
  registerSink,
  clearSinks,
};

// Use explicit relative paths so TS can always resolve them.
export * from './audit/events/index';
export { emitAffiliationVerified as emitAffiliationChange } from './audit/events/affiliation';