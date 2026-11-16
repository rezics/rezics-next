-- migrate:up
-- The named status check already enforces building, sealed, retiring and reclaimed shapes.
ALTER TABLE content.hosted_version_release_candidate
  DROP CONSTRAINT hosted_version_release_candidate_check3;
