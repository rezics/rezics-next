-- migrate: concurrent-index structure.progress_completed_seek
CREATE INDEX CONCURRENTLY progress_completed_seek ON structure.progress
  (principal_issuer, principal_subject, structure, occurrence, selection_key) WHERE completed AND resume_eligible IS DISTINCT FROM false;
