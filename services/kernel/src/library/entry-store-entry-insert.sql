WITH input AS (SELECT :time::timestamptz AS time, :state::text AS state)
INSERT INTO library.entry
  (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at, transaction_id,
   library_profile_pin, incarnation_id, activity_at, finished_at, type_id, type_source_id,
   type_source_partition, type_source_epoch, type_source_position)
SELECT :route, :account_id, :subject_id, :requested_subject_id::nullable(uuid), input.state, 1, input.time, input.time,
       :transaction_id, :library_profile_pin::nullable(jsonb), :incarnation_id::uuid,
       GREATEST(input.time, :last_changed_at::nullable(timestamptz)),
       GREATEST(:last_completed_at::nullable(timestamptz), CASE WHEN input.state = 'completed' THEN input.time END),
       :type_id::nullable(uuid), :source_id::nullable(uuid), :source_partition::nullable(integer),
       :source_epoch::nullable(integer), :source_position::nullable(bigint)
FROM input
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
          requested_subject_id AS "requestedSubjectId", incarnation_id AS "incarnationId", state, revision, created_at::text AS "createdAt",
          updated_at::text AS "updatedAt", transaction_id AS "transactionId";
