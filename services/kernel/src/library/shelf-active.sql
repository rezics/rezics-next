SELECT active.id, active."subjectId", active."versionSubjectId", active.mode, active.unit,
       active.total, active.amount, active.locator, active.position, active."completedUnitCount",
       active.state, active.revision, active."startedAt", active."completedAt"
FROM unnest(:subject_ids::uuid[]) AS requested(subject_id)
CROSS JOIN LATERAL (
  SELECT session_id AS id, subject_id AS "subjectId", version_subject_id AS "versionSubjectId",
         mode, unit, total::text AS total, amount::text AS amount, locator, position::text AS position,
         completed_unit_count AS "completedUnitCount", state, revision,
         started_at::text AS "startedAt", completed_at::text AS "completedAt"
  FROM library.progress_session
  WHERE route = :route AND account_id = :account_id AND subject_id = requested.subject_id
    AND state = 'active'
  ORDER BY last_changed_at DESC, session_id ASC
  LIMIT 1
) AS active;
