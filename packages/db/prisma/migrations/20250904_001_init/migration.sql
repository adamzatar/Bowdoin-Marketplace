-- =============================================================================
-- Bowdoin Marketplace — Initial Schema (extension-agnostic)
-- Postgres 13+
-- =============================================================================

-- Safe UUID helpers (no superuser required) -----------------------------------
-- 1) Fallback pure-SQL UUIDv4 generator (no extensions needed).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'fallback_uuid_v4' AND n.nspname = 'public'
  ) THEN
    CREATE FUNCTION public.fallback_uuid_v4() RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE AS $FN$
    DECLARE
      v uuid;
    BEGIN
      SELECT (
        lpad(to_hex((random()*4294967295)::int), 8, '0') || '-' ||
        lpad(to_hex((random()*    65535)::int), 4, '0') || '-' ||
        '4' || substr(lpad(to_hex((random()*4095)::int), 3, '0'), 1, 3) || '-' ||
        substr('89ab', floor(random()*4)::int+1, 1) ||
        substr(lpad(to_hex((random()*4095)::int), 3, '0'), 1, 3) || '-' ||
        lpad(to_hex((random()*4294967295)::int), 12, '0')
      )::uuid INTO v;
      RETURN v;
    END
    $FN$;
  END IF;
END $$;

-- 2) Wrapper that prefers pgcrypto's gen_random_uuid() if present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'safe_gen_uuid' AND n.nspname = 'public'
  ) THEN
    CREATE FUNCTION public.safe_gen_uuid() RETURNS uuid
    LANGUAGE sql IMMUTABLE AS $FN$
      SELECT CASE
        WHEN to_regproc('gen_random_uuid()') IS NOT NULL THEN gen_random_uuid()
        ELSE public.fallback_uuid_v4()
      END
    $FN$;
  END IF;
END $$;

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
END $$;

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
CREATE TABLE IF NOT EXISTS public."User" (
  "id"            uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "email"         text NOT NULL UNIQUE,
  "name"          text,
  "role"          "Role" NOT NULL DEFAULT 'student',
  "affiliation"   "Affiliation" NOT NULL DEFAULT 'unknown',
  "status"        "AccountStatus" NOT NULL DEFAULT 'active',
  "verifiedAt"    timestamptz,
  "createdAt"     timestamptz NOT NULL DEFAULT NOW(),
  "updatedAt"     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_role         ON public."User" ("role");
CREATE INDEX IF NOT EXISTS idx_user_affiliation  ON public."User" ("affiliation");
CREATE INDEX IF NOT EXISTS idx_user_status       ON public."User" ("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_user_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_user_set_updated_at
    BEFORE UPDATE ON public."User"
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- Listings
CREATE TABLE IF NOT EXISTS public."Listing" (
  "id"              uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "userId"          uuid NOT NULL REFERENCES public."User"("id") ON DELETE CASCADE,
  "title"           text NOT NULL,
  "description"     text,
  "price"           numeric(10,2) NOT NULL DEFAULT 0 CHECK ("price" >= 0),
  "isFree"          boolean NOT NULL DEFAULT FALSE,
  "condition"       "Condition",
  "category"        text,
  "location"        text,
  "availableStart"  date,
  "availableEnd"    date,
  "status"          "ListingStatus" NOT NULL DEFAULT 'active',
  "audience"        "Audience" NOT NULL DEFAULT 'campus',
  "searchVector"    tsvector,
  "createdAt"       timestamptz NOT NULL DEFAULT NOW(),
  "updatedAt"       timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT listing_available_range_chk CHECK (
    "availableStart" IS NULL OR "availableEnd" IS NULL OR "availableEnd" >= "availableStart"
  )
);

CREATE INDEX IF NOT EXISTS idx_listing_user       ON public."Listing" ("userId");
CREATE INDEX IF NOT EXISTS idx_listing_status     ON public."Listing" ("status");
CREATE INDEX IF NOT EXISTS idx_listing_audience   ON public."Listing" ("audience");
CREATE INDEX IF NOT EXISTS idx_listing_created_at ON public."Listing" ("createdAt");
CREATE INDEX IF NOT EXISTS idx_listing_search_vector
  ON public."Listing" USING GIN ("searchVector");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_listing_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_listing_set_updated_at
    BEFORE UPDATE ON public."Listing"
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- Listing Photos
CREATE TABLE IF NOT EXISTS public."ListingPhoto" (
  "id"         uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "listingId"  uuid NOT NULL REFERENCES public."Listing"("id") ON DELETE CASCADE,
  "url"        text NOT NULL,
  "position"   integer NOT NULL DEFAULT 0,
  "createdAt"  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listingphoto_listing ON public."ListingPhoto" ("listingId");
CREATE INDEX IF NOT EXISTS idx_listingphoto_order   ON public."ListingPhoto" ("listingId","position");

-- Threads (buyer-seller per-listing conversation)
CREATE TABLE IF NOT EXISTS public."Thread" (
  "id"         uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "listingId"  uuid NOT NULL REFERENCES public."Listing"("id") ON DELETE CASCADE,
  "sellerId"   uuid NOT NULL REFERENCES public."User"("id"),
  "buyerId"    uuid NOT NULL REFERENCES public."User"("id"),
  "closed"     boolean NOT NULL DEFAULT FALSE,
  "createdAt"  timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT thread_parties_chk CHECK ("sellerId" <> "buyerId"),
  CONSTRAINT thread_unique_per_buyer UNIQUE ("listingId","buyerId")
);

CREATE INDEX IF NOT EXISTS idx_thread_listing ON public."Thread" ("listingId");
CREATE INDEX IF NOT EXISTS idx_thread_seller  ON public."Thread" ("sellerId");
CREATE INDEX IF NOT EXISTS idx_thread_buyer   ON public."Thread" ("buyerId");

-- Messages
CREATE TABLE IF NOT EXISTS public."Message" (
  "id"        uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "threadId"  uuid NOT NULL REFERENCES public."Thread"("id") ON DELETE CASCADE,
  "senderId"  uuid NOT NULL REFERENCES public."User"("id"),
  "body"      text NOT NULL,
  "sentAt"    timestamptz NOT NULL DEFAULT NOW(),
  "readAt"    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_message_thread ON public."Message" ("threadId","sentAt");
CREATE INDEX IF NOT EXISTS idx_message_sender ON public."Message" ("senderId","sentAt");

-- Reports (Moderation)
CREATE TABLE IF NOT EXISTS public."Report" (
  "id"                 uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "reportedListingId"  uuid REFERENCES public."Listing"("id") ON DELETE CASCADE,
  "reportedUserId"     uuid REFERENCES public."User"("id"),
  "reporterId"         uuid NOT NULL REFERENCES public."User"("id"),
  "reason"             text,
  "status"             "ReportStatus" NOT NULL DEFAULT 'open',
  "createdAt"          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT report_target_not_null_chk CHECK (
    "reportedListingId" IS NOT NULL OR "reportedUserId" IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_report_listing ON public."Report" ("reportedListingId");
CREATE INDEX IF NOT EXISTS idx_report_user    ON public."Report" ("reportedUserId");
CREATE INDEX IF NOT EXISTS idx_report_status  ON public."Report" ("status");

-- Audit Log (append-only)
CREATE TABLE IF NOT EXISTS public."AuditLog" (
  "id"          bigserial PRIMARY KEY,
  "timestamp"   timestamptz NOT NULL DEFAULT NOW(),
  "actorUserId" uuid REFERENCES public."User"("id"),
  "action"      text NOT NULL,
  "entityType"  text NOT NULL,
  "entityId"    uuid,
  "meta"        jsonb,
  "ip"          inet,
  "userAgent"   text
);

CREATE INDEX IF NOT EXISTS idx_auditlog_time   ON public."AuditLog" ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_auditlog_entity ON public."AuditLog" ("entityType","entityId");
CREATE INDEX IF NOT EXISTS idx_auditlog_actor  ON public."AuditLog" ("actorUserId");

-- Email/Out-of-band verification token
CREATE TABLE IF NOT EXISTS public."VerificationToken" (
  "id"        uuid PRIMARY KEY DEFAULT public.safe_gen_uuid(),
  "userId"    uuid REFERENCES public."User"("id") ON DELETE CASCADE,
  "email"     text NOT NULL,
  "token"     text NOT NULL,
  "expires"   timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT verification_token_unique UNIQUE ("email","token")
);

CREATE INDEX IF NOT EXISTS idx_verification_user ON public."VerificationToken" ("userId");
CREATE INDEX IF NOT EXISTS idx_verification_exp  ON public."VerificationToken" ("expires");

-- Comments --------------------------------------------------------------------
COMMENT ON TABLE public."User"              IS 'SSO users; includes role, affiliation (bowdoin/brunswick/unknown), and status.';
COMMENT ON TABLE public."Listing"           IS 'Items listed for exchange; has FTS vector and audience field.';
COMMENT ON TABLE public."Thread"            IS 'Conversation between seller and a specific buyer for a listing.';
COMMENT ON TABLE public."Message"           IS 'Per-thread message events.';
COMMENT ON TABLE public."Report"            IS 'Moderation reports for listings or users.';
COMMENT ON TABLE public."AuditLog"          IS 'Append-only audit trail for security/compliance.';
COMMENT ON TABLE public."VerificationToken" IS 'Email verification for community users and similar flows.';

-- End -------------------------------------------------------------------------