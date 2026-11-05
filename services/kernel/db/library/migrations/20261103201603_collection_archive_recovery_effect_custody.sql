-- migrate:up
-- Keep the exact native effect identity and operands until its original receipt is reconciled.
ALTER TABLE library.collection_archive_recovery
  ADD COLUMN inflight_effect_id uuid,
  ADD COLUMN inflight_effect_key text,
  ADD COLUMN inflight_operands jsonb,
  ADD COLUMN inflight_review_id uuid,
  ADD COLUMN inflight_review_digest text,
  ADD COLUMN inflight_review_epoch bigint;

ALTER TABLE library.collection_archive_recovery
  ADD CONSTRAINT collection_archive_recovery_effect_custody_check CHECK (
    (inflight_effect_id IS NULL AND inflight_effect_key IS NULL AND inflight_operands IS NULL
      AND inflight_review_id IS NULL AND inflight_review_digest IS NULL AND inflight_review_epoch IS NULL)
    OR (inflight_action IS NOT NULL AND inflight_effect_id IS NOT NULL AND inflight_effect_key IS NOT NULL
      AND inflight_operands IS NOT NULL AND inflight_review_id IS NOT NULL
      AND inflight_review_digest IS NOT NULL AND inflight_review_epoch IS NOT NULL
      AND octet_length(inflight_effect_key) BETWEEN 1 AND 1024
      AND jsonb_typeof(inflight_operands) = 'object' AND pg_column_size(inflight_operands) <= 65536
      AND inflight_review_digest ~ '^[0-9a-f]{64}$'
      AND inflight_review_epoch >= 1)
  );

-- migrate:down
-- Forward only: this custody is required to reconcile admitted native facts safely.
