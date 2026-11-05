-- migrate:up
ALTER TABLE library.published_log
  ALTER COLUMN account_id DROP NOT NULL,
  ALTER COLUMN subject_id DROP NOT NULL,
  ALTER COLUMN session_state DROP NOT NULL,
  ALTER COLUMN started_at DROP NOT NULL,
  ALTER COLUMN published_at DROP NOT NULL,
  ALTER COLUMN transaction_id DROP NOT NULL,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483646),
  ADD COLUMN deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN deletion_id uuid,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN restore_until timestamptz,
  ADD COLUMN partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  ADD CONSTRAINT published_log_episode CHECK (
    (NOT deleted AND deletion_id IS NULL AND deleted_at IS NULL AND restore_until IS NULL)
    OR (deleted AND deletion_id IS NOT NULL AND deleted_at IS NOT NULL
        AND restore_until = deleted_at + interval '720 hours')
    OR (deleted AND account_id IS NULL AND deletion_id IS NULL AND deleted_at IS NULL AND restore_until IS NULL)
  ),
  ADD CONSTRAINT published_log_payload CHECK (
    (account_id IS NOT NULL AND subject_id IS NOT NULL AND session_state IS NOT NULL
      AND started_at IS NOT NULL AND published_at IS NOT NULL AND transaction_id IS NOT NULL)
    OR (deleted AND account_id IS NULL AND session_id IS NULL AND subject_id IS NULL
      AND session_state IS NULL AND started_at IS NULL AND completed_at IS NULL AND note IS NULL
      AND published_at IS NULL AND transaction_id IS NULL)
  );
DROP INDEX library.published_log_account_page;
CREATE INDEX published_log_account_page
  ON library.published_log (route, account_id, published_at DESC, log_id) WHERE NOT deleted;
CREATE INDEX published_log_owner
  ON library.published_log (route, account_id, log_id) WHERE account_id IS NOT NULL;
CREATE INDEX published_log_due
  ON library.published_log (partition_no, restore_until, route, log_id)
  WHERE deleted AND restore_until IS NOT NULL;
CREATE TRIGGER published_log_fact_insert AFTER INSERT ON library.published_log
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER published_log_fact_visibility AFTER UPDATE ON library.published_log
  FOR EACH ROW WHEN (OLD.deleted IS DISTINCT FROM NEW.deleted)
  EXECUTE FUNCTION library.advance_fact_source_head();
-- Terminal cleanup precedes removal of fact_source_head. Ordinary minimization never invalidates twice.
CREATE TRIGGER published_log_fact_delete AFTER DELETE ON library.published_log
  FOR EACH ROW WHEN (OLD.account_id IS NOT NULL AND NOT OLD.deleted)
  EXECUTE FUNCTION library.advance_fact_source_head();

-- migrate:down
-- Forward only: lifecycle payload cannot be reconstructed after minimization.
