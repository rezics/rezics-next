-- migrate:up
ALTER TABLE content.hosted_publication_staging_step
  DROP CONSTRAINT hosted_publication_staging_step_phase_check;
ALTER TABLE content.hosted_publication_staging_step
  ADD CONSTRAINT hosted_publication_staging_step_phase_check
    CHECK (phase IN ('whole', 'selection', 'closure', 'candidate_begin', 'candidate_page', 'exhausted', 'terminal'));
ALTER TABLE content.hosted_publication_staging_step
  ADD COLUMN result_preparation jsonb,
  ADD CONSTRAINT hosted_publication_staging_step_preparation_check CHECK (
    result_preparation IS NULL OR (
      jsonb_typeof(result_preparation) = 'object'
      AND octet_length(result_preparation::text) <= 8192
      AND result_preparation->>'catalogueId' = catalogue_id::text
      AND result_preparation->>'stageId' = stage_id::text
    )
  );

-- migrate:down
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM content.hosted_publication_staging_step
    WHERE result_preparation IS NOT NULL OR phase IN ('candidate_begin', 'candidate_page', 'exhausted', 'terminal')
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot roll back hosted publication advance receipts after acknowledgement'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
ALTER TABLE content.hosted_publication_staging_step
  DROP CONSTRAINT hosted_publication_staging_step_preparation_check,
  DROP COLUMN result_preparation;
ALTER TABLE content.hosted_publication_staging_step
  DROP CONSTRAINT hosted_publication_staging_step_phase_check;
ALTER TABLE content.hosted_publication_staging_step
  ADD CONSTRAINT hosted_publication_staging_step_phase_check
    CHECK (phase IN ('whole', 'selection', 'closure'));
