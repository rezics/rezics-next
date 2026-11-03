UPDATE library.progress_session
SET amount = :amount::nullable(numeric),
    locator = :locator::nullable(text),
    position = :position::nullable(numeric),
    additional_measures = :additional_measures::jsonb,
    completed_unit_count = :completed_unit_count,
    state = :state,
    completed_at = :completed_at::nullable(timestamptz),
    last_changed_at = GREATEST(last_changed_at, :time::timestamptz),
    revision = revision + 1,
    transaction_id = :transaction_id
WHERE route = :route AND session_id = :session_id AND revision = :revision
RETURNING route, session_id AS id, account_id AS "accountId", subject_id AS "subjectId",
          version_subject_id AS "versionSubjectId", mode, unit, total::text AS total, amount::text AS amount, locator,
          position::text AS position, completed_unit_count AS "completedUnitCount", state, revision,
          started_at::text AS "startedAt", completed_at::text AS "completedAt", transaction_id AS "transactionId",
          additional_measures AS "additionalMeasures";
