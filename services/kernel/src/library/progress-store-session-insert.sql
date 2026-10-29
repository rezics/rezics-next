INSERT INTO library.progress_session
  (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount, locator, position,
   completed_unit_count, state, revision, started_at, last_changed_at, completed_at, transaction_id,
   library_profile_pin)
VALUES
  (:route, :session_id, :account_id, :subject_id, :version_subject_id::nullable(uuid), :mode, :unit,
   :total::nullable(numeric), NULL, NULL, NULL, 0, 'active', 1, :time::timestamptz, :last_changed_at::timestamptz,
   NULL, :transaction_id, :library_profile_pin::nullable(jsonb))
RETURNING route, session_id AS id, account_id AS "accountId", subject_id AS "subjectId",
          version_subject_id AS "versionSubjectId", mode, unit, total::text AS total, amount::text AS amount, locator,
          position::text AS position, completed_unit_count AS "completedUnitCount", state, revision,
          started_at::text AS "startedAt", completed_at::text AS "completedAt", transaction_id AS "transactionId";
