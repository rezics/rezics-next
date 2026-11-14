-- Explicit one-time preparation for an existing, stopped development database.
BEGIN;
ALTER TABLE library.hosted_reading ADD COLUMN IF NOT EXISTS target_post_id uuid;
CREATE INDEX IF NOT EXISTS hosted_reading_missing_post
  ON library.hosted_reading(route,account_id,subject_id) WHERE target_post_id IS NULL;
COMMIT;
