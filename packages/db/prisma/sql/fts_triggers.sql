-- -----------------------------------------------------------------------------
-- Full-Text Search & Trigram Support for Listings
-- - Requires: Postgres extensions "unaccent" and "pg_trgm"
-- - Maintains a weighted tsvector on "Listing"."searchVector"
-- - Adds trigram indexes for fuzzy/typo-tolerant lookup on title/description/category
-- -----------------------------------------------------------------------------

-- Ensure extensions exist (no-op if already present)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- Helper: build weighted tsvector from Listing fields
-- We use 'simple' + unaccent to avoid stemming surprises (proper nouns, etc.).
-- Weights:
--   A = title, B = category, C = description
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listing_build_search_vector(
  p_title text,
  p_category text,
  p_description text
) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  setweight(to_tsvector('simple', unaccent(coalesce(p_title, ''))), 'A') ||
  setweight(to_tsvector('simple', unaccent(coalesce(p_category, ''))), 'B') ||
  setweight(to_tsvector('simple', unaccent(coalesce(p_description, ''))), 'C')
$$;

COMMENT ON FUNCTION public.listing_build_search_vector(text, text, text)
  IS 'Builds weighted tsvector for Listing (title A, category B, description C) using unaccent + simple config.';

-- -----------------------------------------------------------------------------
-- Trigger function to refresh "searchVector" on INSERT/UPDATE
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_listings_refresh_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."searchVector" :=
    public.listing_build_search_vector(
      NEW."title",
      NEW."category",
      NEW."description"
    );
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.trg_listings_refresh_search_vector()
  IS 'Maintains "Listing"."searchVector" on insert/update.';

-- -----------------------------------------------------------------------------
-- Drop & recreate trigger to ensure latest definition
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS listing_searchvector_refresh ON "Listing";

CREATE TRIGGER listing_searchvector_refresh
BEFORE INSERT OR UPDATE OF "title", "category", "description"
ON "Listing"
FOR EACH ROW
EXECUTE FUNCTION public.trg_listings_refresh_search_vector();

-- -----------------------------------------------------------------------------
-- Backfill existing rows (safe to run repeatedly)
-- -----------------------------------------------------------------------------
UPDATE "Listing" l
SET "searchVector" = public.listing_build_search_vector(
  l."title",
  l."category",
  l."description"
)
WHERE l."searchVector" IS NULL;

-- -----------------------------------------------------------------------------
-- Indexes
-- Note: Prisma already declares a GIN index on "searchVector" in the schema.
-- We still create defensively here in case the DB was initialized externally.
-- (Postgres supports IF NOT EXISTS.)
-- -----------------------------------------------------------------------------

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_listing_search_vector
ON "Listing"
USING GIN ("searchVector");

-- Trigram indexes (GIN) for fuzzy matching on normalized (lower+unaccent) text
-- These power ILIKE-like fuzzy searches and ranking blends with FTS when desired.
CREATE INDEX IF NOT EXISTS idx_listing_title_trgm
ON "Listing"
USING GIN ( (unaccent(lower("title"))) gin_trgm_ops );

CREATE INDEX IF NOT EXISTS idx_listing_category_trgm
ON "Listing"
USING GIN ( (unaccent(lower("category"))) gin_trgm_ops );

CREATE INDEX IF NOT EXISTS idx_listing_description_trgm
ON "Listing"
USING GIN ( (unaccent(lower("description"))) gin_trgm_ops );

-- -----------------------------------------------------------------------------
-- Optional: REINDEX guidance (run manually during maintenance windows)
-- -- REINDEX INDEX CONCURRENTLY idx_listing_title_trgm;
-- -- REINDEX INDEX CONCURRENTLY idx_listing_description_trgm;
-- -- REINDEX INDEX CONCURRENTLY idx_listing_category_trgm;
-- -----------------------------------------------------------------------------