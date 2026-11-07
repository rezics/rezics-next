-- Correlated active-session points retain progress_session_active under generic
-- prepared plans. Equality plus LIMIT 1 Seq Scanned a small session table.
-- Unnest as a sibling MATERIALIZED keys CTE was hash-joined the same way and
-- its ORDER BY added a Sort the active index does not need. Drive one integer
-- step from the MATERIALIZED request row that carries the subject-id array,
-- then a MATERIALIZED one-row point CTE inside LATERAL, so each seek is the
-- unique-key point: Access ROW-bounded (route, account_id, subject_id) range
-- and OFFSET 0. ORDER BY names that index. Page LIMIT stays after OFFSET 0.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_ids::uuid[] AS subject_ids
)
SELECT active.id, active."subjectId", active."versionSubjectId", active.mode, active.unit,
       active.total, active.amount, active.locator, active.position, active."completedUnitCount",
       active.state, active.revision, active."startedAt", active."completedAt"
FROM input
CROSS JOIN LATERAL (
  SELECT step.i FROM generate_series(1, cardinality(input.subject_ids)) AS step(i)
) AS step
CROSS JOIN LATERAL (
  WITH point AS MATERIALIZED (
    SELECT input.route, input.account_id, input.subject_ids[step.i] AS subject_id
  )
  SELECT session.session_id AS id, session.subject_id AS "subjectId",
         session.version_subject_id AS "versionSubjectId",
         session.mode, session.unit, session.total::text AS total, session.amount::text AS amount,
         session.locator, session.position::text AS position,
         session.completed_unit_count AS "completedUnitCount", session.state, session.revision,
         session.started_at::text AS "startedAt", session.completed_at::text AS "completedAt"
  FROM point
  CROSS JOIN LATERAL (
    SELECT sought.session_id, sought.subject_id, sought.version_subject_id, sought.mode, sought.unit,
           sought.total, sought.amount, sought.locator, sought.position, sought.completed_unit_count,
           sought.state, sought.revision, sought.started_at, sought.completed_at
    FROM library.progress_session AS sought
    WHERE ROW(sought.route, sought.account_id, sought.subject_id)
            >= ROW(point.route, point.account_id, point.subject_id)
      AND ROW(sought.route, sought.account_id, sought.subject_id)
            <= ROW(point.route, point.account_id, point.subject_id)
      AND sought.state = 'active'
    ORDER BY sought.route, sought.account_id, sought.subject_id, sought.last_changed_at DESC,
             sought.session_id
    OFFSET 0
    LIMIT 1
  ) AS session
) AS active;
