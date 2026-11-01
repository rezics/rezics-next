-- migrate:up
ALTER TABLE semantic.public_filter_privacy_log
  DROP CONSTRAINT public_filter_privacy_log_cause_check,
  ADD CONSTRAINT public_filter_privacy_log_cause_check CHECK
    (cause IN ('subject','candidate','selection','sourceTuple','consent','collection','realm','board'));

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native Realm privacy causes require retained Source retirement';
END $$;
