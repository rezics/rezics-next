-- migrate: concurrent-index structure.progress_order_seek
CREATE INDEX CONCURRENTLY progress_order_seek ON structure.progress
  (principal_issuer, principal_subject, structure, order_revision, order_key DESC,
    occurrence DESC, selection_key ASC) WHERE completed AND resume_eligible AND order_key IS NOT NULL;
