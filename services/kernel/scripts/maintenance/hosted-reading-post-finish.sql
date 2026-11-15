-- Run only after an advance call examined zero remaining checkpoints.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM library.hosted_reading WHERE target_post_id IS NULL LIMIT 1) THEN
    RAISE EXCEPTION 'Hosted reading exact Post conversion is incomplete' USING ERRCODE='23514';
  END IF;
END;
$$;
ALTER TABLE library.hosted_reading ALTER COLUMN target_post_id SET NOT NULL;
DROP INDEX IF EXISTS library.hosted_reading_missing_post;
COMMIT;
