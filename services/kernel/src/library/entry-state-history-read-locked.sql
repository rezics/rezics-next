SELECT revision, prior_revision AS "priorRevision", before_state AS "beforeState",
       before_profile_pin AS "beforeProfilePin", after_state AS "afterState",
       after_profile_pin AS "afterProfilePin", command_id AS "commandId", command_kind AS "commandKind",
       changed_at::text AS "changedAt", coverage_complete AS "coverageComplete"
FROM library.entry_state_change
WHERE route = :route::integer AND account_id = :account_id::uuid AND subject_id = :subject_id::uuid
  AND incarnation_id = :incarnation_id::uuid AND revision = :revision::integer
FOR SHARE;
