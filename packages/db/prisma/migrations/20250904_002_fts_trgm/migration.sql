-- =============================================================================
-- Bowdoin Marketplace — FTS + Trigram wiring for "Listing"
-- Depends on: 20250904_init (tables & columns exist)
-- Postgres 13+ ; requires unaccent + pg_trgm extensions
-- =============================================================================

-- Ensure required extensions (idempotent if already created in init)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- Helper function: normalize text (lower + unaccent, safe on NULL)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_text(txt TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT lower(unaccent($1))
$$;

COMMENT ON FUNCTION public.normalize_text(TEXT)
  IS 'Lowercase + unaccent normalization for consistent FTS and trigram matching.';

-- -----------------------------------------------------------------------------
-- FTS document builder: combine title/description/category with weights
--  - A: title
--  - B: category
--  - C: description
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listing_fts_document(
  p_title TEXT,
  p_description TEXT,
  p_category TEXT
) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
      setweight(to_tsvector('english', coalesce(unaccent(p_title), '')),     'A')
    || setweight(to_tsvector('english', coalesce(unaccent(p_category), '')), 'B')
    || setweight(to_tsvector('english', coalesce(unaccent(p_description), '')), 'C');
$$;

COMMENT ON FUNCTION public.listing_fts_document(TEXT, TEXT, TEXT)
  IS 'Build weighted, unaccented tsvector for Listing rows.';

-- -----------------------------------------------------------------------------
-- Trigger function: keep Listing.searchVector up-to-date on INSERT/UPDATE
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_listing_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."searchVector" := public.listing_fts_document(
    NEW."title",
    NEW."description",
    NEW."category"
  );
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.trg_listing_search_vector()
  IS 'Maintains Listing.searchVector via BEFORE INSERT/UPDATE trigger.';

-- -----------------------------------------------------------------------------
-- Attach trigger to Listing (idempotent pattern: drop then create)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'Listing' AND t.tgname = 'trg_listing_search_vector_biu'
  ) THEN
    DROP TRIGGER trg_listing_search_vector_biu ON "Listing";
  END IF;
END$$;

CREATE TRIGGER trg_listing_search_vector_biu
BEFORE INSERT OR UPDATE OF "title","description","category"
ON "Listing"
FOR EACH ROW
EXECUTE FUNCTION public.trg_listing_search_vector();

-- -----------------------------------------------------------------------------
-- Indexes: FTS (GIN) and Trigram (GIN/GIN_TRGM) for fuzzy matching
-- -----------------------------------------------------------------------------

-- FTS index on the materialized column
CREATE INDEX IF NOT EXISTS idx_listing_fts_gin
  ON "Listing"
  USING GIN ("searchVector");

-- Trigram on title for fast ILIKE & similarity queries
CREATE INDEX IF NOT EXISTS idx_listing_title_trgm
  ON "Listing"
  USING GIN (public.normalize_text("title") gin_trgm_ops);

-- Trigram on description for fallback fuzzy matches (optional but useful)
CREATE INDEX IF NOT EXISTS idx_listing_description_trgm
  ON "Listing"
  USING GIN (public.normalize_text("description") gin_trgm_ops);

-- Optional: Category trigram if filtering often includes free-text categories
CREATE INDEX IF NOT EXISTS idx_listing_category_trgm
  ON "Listing"
  USING GIN (public.normalize_text("category") gin_trgm_ops);

COMMENT ON INDEX idx_listing_fts_gin              IS 'GIN index for full-text search on Listing.searchVector';
COMMENT ON INDEX idx_listing_title_trgm           IS 'Trigram GIN for fuzzy title matches & ILIKE';
COMMENT ON INDEX idx_listing_description_trgm     IS 'Trigram GIN for fuzzy description matches & ILIKE';
COMMENT ON INDEX idx_listing_category_trgm        IS 'Trigram GIN for fuzzy category matches & ILIKE';

-- -----------------------------------------------------------------------------
-- Backfill existing rows (safe to run multiple times)
-- -----------------------------------------------------------------------------
UPDATE "Listing" l
SET "searchVector" = public.listing_fts_document(l."title", l."description", l."category")
WHERE l."searchVector" IS NULL;

-- (Optional) ANALYZE to help planner immediately after large backfills
ANALYZE "Listing";