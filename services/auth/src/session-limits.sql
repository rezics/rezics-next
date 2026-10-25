-- Admission precedes row locking, so even a locked expired prefix cannot cause
-- SKIP LOCKED to walk arbitrarily far looking for an unlocked batch.
WITH admitted AS MATERIALIZED (
  SELECT id FROM session WHERE "expiresAt" <= statement_timestamp()
  ORDER BY "expiresAt", id LIMIT $1
), locked AS MATERIALIZED (
  SELECT candidate.id FROM admitted
  CROSS JOIN LATERAL (
    SELECT id FROM session WHERE id=admitted.id FOR UPDATE SKIP LOCKED
  ) candidate
)
DELETE FROM session WHERE id=ANY(ARRAY(SELECT id FROM locked));
