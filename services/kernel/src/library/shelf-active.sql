-- Correlated LIMIT-1 active-session points retain the partial index under generic prepared plans.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT active.id, active."subjectId", active."versionSubjectId", active.mode, active.unit,
       active.total, active.amount, active.locator, active.position, active."completedUnitCount",
       active.state, active.revision, active."startedAt", active."completedAt"
FROM input
CROSS JOIN unnest(:subject_ids::uuid[]) AS requested(subject_id)
CROSS JOIN LATERAL (
  SELECT session.session_id AS id, session.subject_id AS "subjectId",
         session.version_subject_id AS "versionSubjectId",
         session.mode, session.unit, session.total::text AS total, session.amount::text AS amount,
         session.locator, session.position::text AS position,
         session.completed_unit_count AS "completedUnitCount", session.state, session.revision,
         session.started_at::text AS "startedAt", session.completed_at::text AS "completedAt"
  FROM library.progress_session AS session
  WHERE session.route = input.route AND session.account_id = input.account_id
    AND session.subject_id = requested.subject_id
    AND session.state = 'active'
  ORDER BY session.route, session.account_id, session.subject_id, session.last_changed_at DESC,
           session.session_id
  OFFSET 0
  LIMIT 1
) AS active;
