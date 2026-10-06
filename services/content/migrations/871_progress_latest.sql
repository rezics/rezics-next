-- ORDER BY ... LIMIT 1 must seek directly, including deterministic selection ties.
-- https://www.postgresql.org/docs/18/indexes-ordering.html
CREATE INDEX progress_latest ON structure.progress
  (principal_issuer, principal_subject, structure, updated_at DESC, occurrence DESC, selection_key);
