-- migrate:up
ALTER TABLE library.copy
  ADD COLUMN deletion_id uuid,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN restore_until timestamptz,
  ADD COLUMN partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  ADD CONSTRAINT copy_retention_episode CHECK (
    (deletion_id IS NULL AND deleted_at IS NULL AND restore_until IS NULL) OR
    (deletion_id IS NOT NULL AND deleted_at IS NOT NULL AND restore_until IS NOT NULL
      AND restore_until = deleted_at + interval '720 hours')
  );
-- Keep the all-state owner index for terminal account erasure. Ordinary readers seek only live rows.
CREATE INDEX copy_live_created ON library.copy (route, account_id, created_at, copy_id) WHERE deletion_id IS NULL;
CREATE INDEX copy_live_subject_created ON library.copy (route, account_id, subject_id, created_at, copy_id) WHERE deletion_id IS NULL;
CREATE INDEX copy_live_raw_source ON library.copy (route, account_id, subject_id, copy_id) WHERE deletion_id IS NULL;
CREATE INDEX copy_retention_due ON library.copy (partition_no, restore_until, route, copy_id) WHERE deletion_id IS NOT NULL;
DROP TRIGGER copy_fact_source_rows ON library.copy;
CREATE TRIGGER copy_fact_source_rows AFTER INSERT ON library.copy
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER copy_fact_source_delete AFTER DELETE ON library.copy
  FOR EACH ROW WHEN (OLD.deletion_id IS NULL) EXECUTE FUNCTION library.advance_fact_source_head();

-- migrate:down
DROP TRIGGER copy_fact_source_delete ON library.copy;
DROP TRIGGER copy_fact_source_rows ON library.copy;
CREATE TRIGGER copy_fact_source_rows AFTER INSERT OR DELETE ON library.copy
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
DROP INDEX library.copy_retention_due;
DROP INDEX library.copy_live_raw_source;
DROP INDEX library.copy_live_subject_created;
DROP INDEX library.copy_live_created;
ALTER TABLE library.copy DROP CONSTRAINT copy_retention_episode,
  DROP COLUMN deletion_id, DROP COLUMN deleted_at, DROP COLUMN restore_until, DROP COLUMN partition_no;
