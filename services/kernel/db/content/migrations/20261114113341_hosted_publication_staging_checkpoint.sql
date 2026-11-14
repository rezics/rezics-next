-- migrate:up
-- New advances retain the exact bounded checkpoint needed for replay. Existing
-- immutable receipts remain valid with a NULL snapshot and use the documented
-- unavailable recovery path.
ALTER TABLE content.hosted_publication_staging_step
  ADD COLUMN result_checkpoint jsonb,
  ADD CONSTRAINT hosted_publication_staging_step_checkpoint_check CHECK (
    result_checkpoint IS NULL OR (
      COALESCE(
        jsonb_typeof(result_checkpoint) = 'object'
        AND octet_length(result_checkpoint::text) <= 8192
        AND jsonb_typeof(result_checkpoint->'locator') = 'object'
        AND result_checkpoint->'locator'->>'catalogueId' = catalogue_id::text
        AND result_checkpoint->'locator'->>'stageId' = stage_id::text
        AND result_checkpoint->>'mode' IN ('whole', 'selection')
        AND result_checkpoint->>'state' IN (
          'collecting', 'building', 'closing', 'ready', 'sealed', 'cancelled', 'expired', 'failed'
        )
        AND (
          (result_state = 'failed' AND result_checkpoint->>'state' = 'failed')
          OR (result_state = 'ready' AND result_checkpoint->>'state' = 'ready')
          OR (result_state = 'more' AND result_checkpoint->>'state' NOT IN ('failed', 'ready'))
        ),
        false
      )
    )
  );

-- migrate:down
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM content.hosted_publication_staging_step
    WHERE result_checkpoint IS NOT NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot roll back hosted publication step checkpoints after acknowledgement'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
ALTER TABLE content.hosted_publication_staging_step
  DROP CONSTRAINT hosted_publication_staging_step_checkpoint_check,
  DROP COLUMN result_checkpoint;
