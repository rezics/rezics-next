-- migrate:up
ALTER TABLE content.hosted_publication_staging_candidate
  DROP CONSTRAINT hosted_publication_staging_candidate_source_segment_check,
  ADD CONSTRAINT hosted_publication_staging_candidate_source_segment_check
    CHECK (source_segment IN ('snapshot', 'base', 'append', 'ordered'));

-- migrate:down
ALTER TABLE content.hosted_publication_staging_candidate
  DROP CONSTRAINT hosted_publication_staging_candidate_source_segment_check,
  ADD CONSTRAINT hosted_publication_staging_candidate_source_segment_check
    CHECK (source_segment IN ('snapshot', 'base', 'append'));
