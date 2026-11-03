-- migrate:up
-- Content's exact source-fence invalidation walks subjects, not provider history.
CREATE INDEX source_candidate_review_discovery_tuple ON semantic.source_candidate
  (route,source,external_id,field_group,subject_id);

-- migrate:down
DROP INDEX semantic.source_candidate_review_discovery_tuple;
