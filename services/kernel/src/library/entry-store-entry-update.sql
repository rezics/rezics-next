WITH input AS (SELECT :expected_incarnation_id::nullable(uuid) AS expected_incarnation_id, :time::timestamptz AS time, :state::text AS next_state)
UPDATE library.entry
SET activity_at = GREATEST(activity_at, input.time), state = input.next_state, revision = revision + 1, updated_at = input.time, transaction_id = :transaction_id,
    finished_at = GREATEST(finished_at, CASE WHEN input.next_state = 'completed' AND library.entry.state <> 'completed' THEN input.time END),
    library_profile_pin = COALESCE(:library_profile_pin::nullable(jsonb), library_profile_pin)
FROM input
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id AND revision = :revision
  AND (input.expected_incarnation_id IS NULL OR incarnation_id = input.expected_incarnation_id)
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
          requested_subject_id AS "requestedSubjectId", incarnation_id AS "incarnationId", state, revision, created_at::text AS "createdAt",
          updated_at::text AS "updatedAt", transaction_id AS "transactionId";
