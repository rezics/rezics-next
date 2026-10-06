-- migrate: concurrent-index structure.progress_latest
-- ORDER BY ... LIMIT 1 must seek directly, including deterministic selection ties.
-- https://www.postgresql.org/docs/18/indexes-ordering.html
-- Concurrent builds cannot run in a transaction and leave an invalid index on
-- cancellation; the runner drops that invalid index concurrently before retry.
-- https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY
CREATE INDEX CONCURRENTLY progress_latest ON structure.progress
  (principal_issuer, principal_subject, structure, updated_at DESC, occurrence DESC, selection_key);
