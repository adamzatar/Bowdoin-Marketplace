-- =============================================================================
-- Bowdoin Marketplace — Audit Logs (Migration 003)
-- Depends on: 20250904_init
-- Postgres 13+ (uses pgcrypto for gen_random_uuid, inet, jsonb)
-- =============================================================================

-- Ensure crypto extension (safe if already present)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums (create only if missing)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_event') THEN
    CREATE TYPE audit_event AS ENUM (
      'AUTH_SIGNIN',
      'AUTH_SIGNOUT',
      'USER_CREATE',
      'USER_UPDATE',
      'AFFILIATION_REQUESTED',
      'AFFILIATION_VERIFIED',
      'AFFILIATION_REJECTED',
      'LISTING_CREATE',
      'LISTING_UPDATE',
      'LISTING_DELETE',
      'LISTING_MARK_SOLD',
      'MESSAGE_SENT',
      'REPORT_FILED',
      'ADMIN_BAN_USER',
      'ADMIN_REMOVE_LISTING',
      'RATE_LIMIT_BLOCK',
      'UPLOAD_REQUESTED',
      'UPLOAD_COMPLETED',
      'UPLOAD_REJECTED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_scope') THEN
    CREATE TYPE audit_scope AS ENUM (
      'AUTH',
      'USER',
      'AFFILIATION',
      'LISTING',
      'MESSAGE',
      'REPORT',
      'ADMIN',
      'SECURITY',
      'UPLOAD',
      'SYSTEM'
    );
  END IF;
END$$;

COMMENT ON TYPE audit_event IS 'Normalized audit event kind.';
COMMENT ON TYPE audit_scope IS 'High-level domain grouping for audit events.';

-- -----------------------------------------------------------------------------
-- Table: AuditLog
-- -----------------------------------------------------------------------------
-- Create the table if it doesn't exist; otherwise, add any missing columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.tables
    WHERE  table_schema = 'public'
    AND    table_name   = 'AuditLog'
  ) THEN
    CREATE TABLE "AuditLog" (
      "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
      "actorUserId" UUID NULL REFERENCES "User"("id") ON DELETE SET NULL,
      "actorIp"     INET NULL,
      "actorUA"     TEXT NULL,
      "event"       audit_event NOT NULL,
      "scope"       audit_scope NOT NULL,
      "targetType"  TEXT NOT NULL,  -- e.g., 'User' | 'Listing' | 'Thread' | 'Report'
      "targetId"    TEXT NULL,      -- UUID or composite key serialized as string
      "metadata"    JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  ELSE
    -- Hardening for partial/failed earlier attempts: add columns if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'createdAt'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now();
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'actorUserId'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "actorUserId" UUID NULL REFERENCES "User"("id") ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'actorIp'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "actorIp" INET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'actorUA'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "actorUA" TEXT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'event'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "event" audit_event NOT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'scope'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "scope" audit_scope NOT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'targetType'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "targetType" TEXT NOT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'targetId'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "targetId" TEXT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'AuditLog' AND column_name = 'metadata'
    ) THEN
      ALTER TABLE "AuditLog" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;
    END IF;
  END IF;
END$$;

COMMENT ON TABLE "AuditLog" IS 'Immutable append-only security/audit trail.';
COMMENT ON COLUMN "AuditLog"."createdAt"   IS 'Event timestamp (server clock).';
COMMENT ON COLUMN "AuditLog"."actorUserId" IS 'User who performed the action, if known.';
COMMENT ON COLUMN "AuditLog"."actorIp"     IS 'Actor IP (from request), if captured.';
COMMENT ON COLUMN "AuditLog"."actorUA"     IS 'Actor User-Agent (truncated/sanitized).';
COMMENT ON COLUMN "AuditLog"."event"       IS 'Specific event type (enum).';
COMMENT ON COLUMN "AuditLog"."scope"       IS 'Domain scope for filtering/reporting.';
COMMENT ON COLUMN "AuditLog"."targetType"  IS 'Entity type impacted by the event.';
COMMENT ON COLUMN "AuditLog"."targetId"    IS 'Entity identifier (string to allow non-UUID).';
COMMENT ON COLUMN "AuditLog"."metadata"    IS 'Redaction-safe contextual info (no secrets/PII).';

-- -----------------------------------------------------------------------------
-- Guard against mutations (append-only)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auditlog_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are immutable (append-only).';
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'AuditLog' AND t.tgname = 'trg_auditlog_block_update'
  ) THEN
    CREATE TRIGGER trg_auditlog_block_update
      BEFORE UPDATE ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION public.auditlog_block_mutations();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'AuditLog' AND t.tgname = 'trg_auditlog_block_delete'
  ) THEN
    CREATE TRIGGER trg_auditlog_block_delete
      BEFORE DELETE ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION public.auditlog_block_mutations();
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- Indexes (create after table & columns exist)
-- -----------------------------------------------------------------------------
-- Time-ordered queries (most recent first)
CREATE INDEX IF NOT EXISTS idx_auditlog_ts_desc
  ON "AuditLog" ("createdAt" DESC);

-- By actor (who did what)
CREATE INDEX IF NOT EXISTS idx_auditlog_actor
  ON "AuditLog" ("actorUserId", "createdAt" DESC);

-- By event type
CREATE INDEX IF NOT EXISTS idx_auditlog_event
  ON "AuditLog" ("event", "createdAt" DESC);

-- By scope
CREATE INDEX IF NOT EXISTS idx_auditlog_scope
  ON "AuditLog" ("scope", "createdAt" DESC);

-- By target (what was affected)
CREATE INDEX IF NOT EXISTS idx_auditlog_target
  ON "AuditLog" ("targetType", "targetId", "createdAt" DESC);

-- Hot-path: rate-limit blocks (for quick abuse investigations)
CREATE INDEX IF NOT EXISTS idx_auditlog_rl_blocks
  ON "AuditLog" ("createdAt" DESC)
  WHERE "event" = 'RATE_LIMIT_BLOCK';

-- JSONB metadata GIN (optional; helpful for ad-hoc investigations)
CREATE INDEX IF NOT EXISTS idx_auditlog_metadata_gin
  ON "AuditLog" USING GIN ("metadata");

-- Notes for ops:
COMMENT ON INDEX idx_auditlog_ts_desc IS 'Use for primary time-ordered queries & retention scans.';

-- Update planner stats (harmless if empty)
ANALYZE "AuditLog";