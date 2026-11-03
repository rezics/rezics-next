UPDATE library.entry_state_change
SET coverage_complete = false
WHERE route = :route::integer AND account_id = :account_id::uuid AND subject_id = :subject_id::uuid
  AND incarnation_id = :incarnation_id::uuid;
