-- =============================================================================
-- 20250904_005_affiliation_backfill_defaults
-- Backfill using existing enum labels from 20250904_001_init:
--   "Affiliation": 'bowdoin' | 'brunswick' | 'unknown'
--   "Audience":    'campus'  | 'community' | 'both'
-- =============================================================================

-- Backfill User.affiliation from 'unknown' -> 'bowdoin' (bowdoin.edu) or 'brunswick' (others)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'affiliation'
  ) THEN
    UPDATE "User"
       SET "affiliation" = 'bowdoin'::"Affiliation"
     WHERE "affiliation" = 'unknown'::"Affiliation"
       AND LOWER(COALESCE("email", '')) LIKE '%@bowdoin.edu';

    UPDATE "User"
       SET "affiliation" = 'brunswick'::"Affiliation"
     WHERE "affiliation" = 'unknown'::"Affiliation"
       AND LOWER(COALESCE("email", '')) NOT LIKE '%@bowdoin.edu';
  END IF;
END$$;

-- Ensure Listing.audience is non-null; default is already 'campus' from 001
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Listing' AND column_name = 'audience'
  ) THEN
    UPDATE "Listing"
       SET "audience" = 'campus'::"Audience"
     WHERE "audience" IS NULL;
  END IF;
END$$;

ANALYZE "User";
ANALYZE "Listing";
