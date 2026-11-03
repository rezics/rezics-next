SELECT revision, prior_revision AS "priorRevision", before_state AS "beforeState",
       after_state AS "afterState", command_id AS "commandId", command_kind AS "commandKind",
       changed_at::text AS "changedAt", coverage_complete AS "coverageComplete"
FROM library.entry_state_change
WHERE route = :route::integer AND account_id = :account_id::uuid AND subject_id = :subject_id::uuid
  AND incarnation_id = :incarnation_id::uuid
  AND (:after_revision::nullable(integer) IS NULL OR revision < :after_revision::nullable(integer))
ORDER BY revision DESC
LIMIT :page_limit::integer;
