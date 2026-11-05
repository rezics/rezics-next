-- migrate:up
-- An original baseline is independently owed even when another observation of
-- the same definition previously repaired this native home.
ALTER TABLE search.public_filter_coverage_home
  ADD COLUMN baseline_bootstrap uuid,
  ADD COLUMN acknowledged_baseline uuid,
  ADD CONSTRAINT public_filter_coverage_home_baseline FOREIGN KEY
    (partition_no,registration,baseline_bootstrap,source_home)
    REFERENCES search.public_filter_coverage_baseline(partition_no,registration,bootstrap,source_home),
  ADD CONSTRAINT public_filter_coverage_home_ack_prefix CHECK (
    behind OR (
      baseline_bootstrap IS NOT NULL AND acknowledged_baseline IS NOT NULL
      AND acknowledged_baseline=baseline_bootstrap
      AND acknowledged_position>=relevant_position
      AND acknowledged_native_enqueue>=native_enqueue_revision
      AND (native_revision IS NULL OR (
        acknowledged_native_revision IS NOT NULL AND acknowledged_native_revision>=native_revision))
      AND (native_claim_revision IS NULL OR (
        acknowledged_native_claim_revision IS NOT NULL AND acknowledged_native_claim_revision>=native_claim_revision))
    ));

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original baseline ACK obligations require retained custody retirement'; END $$;
