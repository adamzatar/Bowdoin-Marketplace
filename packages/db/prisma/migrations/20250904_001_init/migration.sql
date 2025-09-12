-- =============================================================================
-- Bowdoin Marketplace — Initial Schema
-- Postgres 13+ (tested); uses gen_random_uuid() from pgcrypto
-- =============================================================================

-- Extensions ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS unaccent;   -- normalization for search/trgm
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy matching support

-- Enum Types ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Affiliation') THEN
    CREATE TYPE "Affiliation" AS ENUM ('bowdoin', 'brunswick', 'unknown');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccountStatus') THEN
    CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended', 'banned');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ListingStatus') THEN
    CREATE TYPE "ListingStatus" AS ENUM ('active', 'sold', 'expired', 'removed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Condition') THEN
    CREATE TYPE "Condition" AS ENUM ('new', 'good', 'fair', 'poor');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportStatus') THEN
    CREATE TYPE "ReportStatus" AS ENUM ('open', 'reviewed', 'actioned', 'dismissed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN
    CREATE TYPE "Role" AS ENUM ('student', 'staff', 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Audience') THEN
    CREATE TYPE "Audience" AS ENUM ('campus', 'community', 'both');
  END IF;
END$$;

-- Utility: updated_at trigger --------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END
$$;

-- Tables ----------------------------------------------------------------------

-- Users (SSO-backed, no passwords stored here)
CREATE TABLE IF NOT EXISTS "User" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"         TEXT NOT NULL UNIQUE,
  "name"          TEXT,
  "role"          "Role" NOT NULL DEFAULT 'student',
  "affiliation"   "Affiliation" NOT NULL DEFAULT 'unknown',
  "status"        "AccountStatus" NOT NULL DEFAULT 'active',
  "verifiedAt"    TIMESTAMPTZ,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_role         ON "User" ("role");
CREATE INDEX IF NOT EXISTS idx_user_affiliation  ON "User" ("affiliation");
CREATE INDEX IF NOT EXISTS idx_user_status       ON "User" ("status");

CREATE TRIGGER trg_user_set_updated_at
BEFORE UPDATE ON "User"
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Listings
CREATE TABLE IF NOT EXISTS "Listing" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"          UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "title"           TEXT NOT NULL,
  "description"     TEXT,
  "price"           NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK ("price" >= 0),
  "isFree"          BOOLEAN NOT NULL DEFAULT FALSE,
  "condition"       "Condition",
  "category"        TEXT,
  "location"        TEXT,
  "availableStart"  DATE,
  "availableEnd"    DATE,
  "status"          "ListingStatus" NOT NULL DEFAULT 'active',
  "audience"        "Audience" NOT NULL DEFAULT 'campus',
  "searchVector"    TSVECTOR, -- maintained via trigger in fts_triggers.sql
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT listing_available_range_chk CHECK (
    "availableStart" IS NULL OR "availableEnd" IS NULL OR "availableEnd" >= "availableStart"
  )
);

CREATE INDEX IF NOT EXISTS idx_listing_user       ON "Listing" ("userId");
CREATE INDEX IF NOT EXISTS idx_listing_status     ON "Listing" ("status");
CREATE INDEX IF NOT EXISTS idx_listing_audience   ON "Listing" ("audience");
CREATE INDEX IF NOT EXISTS idx_listing_created_at ON "Listing" ("createdAt");
-- GIN for FTS (also created in fts_triggers.sql, safe to duplicate with IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_listing_search_vector
  ON "Listing" USING GIN ("searchVector");

CREATE TRIGGER trg_listing_set_updated_at
BEFORE UPDATE ON "Listing"
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Listing Photos
CREATE TABLE IF NOT EXISTS "ListingPhoto" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "listingId"  UUID NOT NULL REFERENCES "Listing"("id") ON DELETE CASCADE,
  "url"        TEXT NOT NULL,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listingphoto_listing ON "ListingPhoto" ("listingId");
CREATE INDEX IF NOT EXISTS idx_listingphoto_order   ON "ListingPhoto" ("listingId","position");

-- Threads (buyer-seller per-listing conversation)
CREATE TABLE IF NOT EXISTS "Thread" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "listingId"  UUID NOT NULL REFERENCES "Listing"("id") ON DELETE CASCADE,
  "sellerId"   UUID NOT NULL REFERENCES "User"("id"),
  "buyerId"    UUID NOT NULL REFERENCES "User"("id"),
  "closed"     BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT thread_parties_chk CHECK ("sellerId" <> "buyerId"),
  CONSTRAINT thread_unique_per_buyer UNIQUE ("listingId","buyerId")
);

CREATE INDEX IF NOT EXISTS idx_thread_listing ON "Thread" ("listingId");
CREATE INDEX IF NOT EXISTS idx_thread_seller  ON "Thread" ("sellerId");
CREATE INDEX IF NOT EXISTS idx_thread_buyer   ON "Thread" ("buyerId");

-- Messages
CREATE TABLE IF NOT EXISTS "Message" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "threadId"  UUID NOT NULL REFERENCES "Thread"("id") ON DELETE CASCADE,
  "senderId"  UUID NOT NULL REFERENCES "User"("id"),
  "body"      TEXT NOT NULL,
  "sentAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "readAt"    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_message_thread     ON "Message" ("threadId","sentAt");
CREATE INDEX IF NOT EXISTS idx_message_sender     ON "Message" ("senderId","sentAt");

-- Reports (Moderation)
CREATE TABLE IF NOT EXISTS "Report" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reportedListingId"  UUID REFERENCES "Listing"("id") ON DELETE CASCADE,
  "reportedUserId"     UUID REFERENCES "User"("id"),
  "reporterId"         UUID NOT NULL REFERENCES "User"("id"),
  "reason"             TEXT,
  "status"             "ReportStatus" NOT NULL DEFAULT 'open',
  "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_target_not_null_chk CHECK (
    "reportedListingId" IS NOT NULL OR "reportedUserId" IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_report_listing ON "Report" ("reportedListingId");
CREATE INDEX IF NOT EXISTS idx_report_user    ON "Report" ("reportedUserId");
CREATE INDEX IF NOT EXISTS idx_report_status  ON "Report" ("status");

-- Audit Log (append-only)
CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id"          BIGSERIAL PRIMARY KEY,
  "timestamp"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "actorUserId" UUID REFERENCES "User"("id"),
  "action"      TEXT NOT NULL,
  "entityType"  TEXT NOT NULL,        -- e.g., 'listing' | 'user' | 'report' ...
  "entityId"    UUID,
  "meta"        JSONB,                -- extra structured info
  "ip"          INET,
  "userAgent"   TEXT
);

CREATE INDEX IF NOT EXISTS idx_auditlog_time        ON "AuditLog" ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_auditlog_entity      ON "AuditLog" ("entityType","entityId");
CREATE INDEX IF NOT EXISTS idx_auditlog_actor       ON "AuditLog" ("actorUserId");

-- Email/Out-of-band verification token (for community email verification flows)
CREATE TABLE IF NOT EXISTS "VerificationToken" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"    UUID REFERENCES "User"("id") ON DELETE CASCADE,
  "email"     TEXT NOT NULL,
  "token"     TEXT NOT NULL,
  "expires"   TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT verification_token_unique UNIQUE ("email","token")
);

CREATE INDEX IF NOT EXISTS idx_verification_user  ON "VerificationToken" ("userId");
CREATE INDEX IF NOT EXISTS idx_verification_exp   ON "VerificationToken" ("expires");

-- Seed-friendly helper comments ----------------------------------------------
COMMENT ON TABLE "User" IS 'SSO users; includes role, affiliation (bowdoin/brunswick/unknown), and status.';
COMMENT ON TABLE "Listing" IS 'Items listed for exchange; has FTS vector and audience field.';
COMMENT ON TABLE "Thread" IS 'Conversation between seller and a specific buyer for a listing.';
COMMENT ON TABLE "Message" IS 'Per-thread message events.';
COMMENT ON TABLE "Report" IS 'Moderation reports for listings or users.';
COMMENT ON TABLE "AuditLog" IS 'Append-only audit trail for security/compliance.';
COMMENT ON TABLE "VerificationToken" IS 'Email verification for community users and similar flows.';

-- End -------------------------------------------------------------------------