-- Correlated active-session points retain progress_session_active under generic
-- prepared plans. Equality plus LIMIT 1 Seq Scanned a small session table.
-- Unnest without MATERIALIZED keys inlined the UUID array the same way. MATERIALIZED
-- input, MATERIALIZED keys, Access ROW-bounded (route, account_id, subject_id)
-- range, and OFFSET 0 keep the partial index even when the CTE values are
-- constants. ORDER BY names that index. Page LIMIT stays after OFFSET 0.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM unnest(:subject_ids::uuid[]) AS requested(subject_id) ORDER BY subject_id
)
SELECT active.id, active."subjectId", active."versionSubjectId", active.mode, active.unit,
       active.total, active.amount, active.locator, active.position, active."completedUnitCount",
       active.state, active.revision, active."startedAt", active."completedAt"
FROM input
CROSS JOIN keys
CROSS JOIN LATERAL (
  SELECT session.session_id AS id, session.subject_id AS "subjectId",
         session.version_subject_id AS "versionSubjectId",
         session.mode, session.unit, session.total::text AS total, session.amount::text AS amount,
         session.locator, session.position::text AS position,
         session.completed_unit_count AS "completedUnitCount", session.state, session.revision,
         session.started_at::text AS "startedAt", session.completed_at::text AS "completedAt"
  FROM library.progress_session AS session
  WHERE ROW(session.route, session.account_id, session.subject_id)
          >= ROW(input.route, input.account_id, keys.subject_id)
    AND ROW(session.route, session.account_id, session.subject_id)
          <= ROW(input.route, input.account_id, keys.subject_id)
    AND session.state = 'active'
  ORDER BY session.route, session.account_id, session.subject_id, session.last_changed_at DESC,
           session.session_id
  OFFSET 0
  LIMIT 1
) AS active;
