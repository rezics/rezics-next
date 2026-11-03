SELECT route, session_id AS id, account_id AS "accountId", subject_id AS "subjectId",
       version_subject_id AS "versionSubjectId", mode, unit, total::text AS total, amount::text AS amount, locator,
       position::text AS position, completed_unit_count AS "completedUnitCount", state, revision,
       started_at::text AS "startedAt", completed_at::text AS "completedAt", transaction_id AS "transactionId",
       library_profile_pin AS "libraryProfilePin", additional_measures AS "additionalMeasures"
FROM library.progress_session
WHERE route = :route AND session_id = :session_id;
