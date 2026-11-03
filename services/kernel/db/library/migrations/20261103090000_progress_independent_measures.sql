-- migrate:up
ALTER TABLE library.progress_session
  ADD COLUMN additional_measures jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT progress_session_additional_measures_check CHECK (
    CASE WHEN jsonb_typeof(additional_measures) = 'array'
      THEN jsonb_array_length(additional_measures) <= 7
        AND octet_length(additional_measures::text) <= 4096
        AND (mode = 'scalar_amount' OR additional_measures = '[]'::jsonb)
      ELSE false
    END
  );

-- migrate:down
-- Forward only: independent progress measures must not be discarded by rollback.
