-- migrate:up
-- Existing contribution locators remain unchanged. Resource locators never supply authority.
ALTER TABLE core.record_history_purge
  ADD COLUMN reference_kind text NOT NULL DEFAULT 'contribution'
    CHECK(reference_kind IN ('contribution','context','zone')),
  ADD COLUMN resource_id uuid,
  ALTER COLUMN subject_id DROP NOT NULL,
  ALTER COLUMN candidate_id DROP NOT NULL,
  ALTER COLUMN revision DROP NOT NULL,
  ADD CONSTRAINT record_history_purge_reference CHECK(
    (reference_kind='contribution' AND resource_id IS NULL
      AND subject_id IS NOT NULL AND candidate_id IS NOT NULL AND revision IS NOT NULL AND revision>0)
    OR (reference_kind IN ('context','zone') AND resource_id IS NOT NULL
      AND subject_id IS NULL AND candidate_id IS NULL AND revision IS NULL AND document_id IS NULL)
  );
-- migrate:down
-- Forward only: retain restart locators and irreversible minimizer progress.
