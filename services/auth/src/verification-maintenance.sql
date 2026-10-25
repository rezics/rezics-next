-- Cap candidate work too: SKIP LOCKED alone can walk every expired row when
-- another worker holds the prefix. Probe at most 2B candidates and lock/delete
-- at most B=1000. A later invocation can retry a contended prefix.
WITH candidates AS MATERIALIZED (
  SELECT ctid
  FROM verification
  WHERE "expiresAt" < statement_timestamp()
  ORDER BY "expiresAt", id
  LIMIT 2000
), expired AS MATERIALIZED (
  SELECT locked.ctid
  FROM candidates
  CROSS JOIN LATERAL (
    SELECT v.ctid
    FROM verification v
    WHERE v.ctid = candidates.ctid
    FOR UPDATE SKIP LOCKED
  ) AS locked
  LIMIT 1000
)
-- Locks keep these physical keys stable within this statement. The TID array
-- prevents a planner-selected whole-table join on the deletion side.
DELETE FROM verification
WHERE ctid = ANY (ARRAY(SELECT ctid FROM expired));
