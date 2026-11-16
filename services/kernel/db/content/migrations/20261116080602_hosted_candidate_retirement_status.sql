-- migrate:up
-- The named status check already enforces building, sealed, retiring and reclaimed shapes.
ALTER TABLE content.hosted_version_release_candidate
  DROP CONSTRAINT hosted_version_release_candidate_check3;

-- migrate:down
-- Restoring the previous check fails if any candidate has already retired.
ALTER TABLE content.hosted_version_release_candidate
  ADD CONSTRAINT hosted_version_release_candidate_check3 CHECK (
    (status='building' AND sealed_at IS NULL)
    OR (status='sealed' AND sealed_at IS NOT NULL AND coverage_complete)
  );
