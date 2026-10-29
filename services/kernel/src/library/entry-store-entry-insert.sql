WITH input AS (SELECT :time::timestamptz AS time)
INSERT INTO library.entry
  (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at, transaction_id,
   library_profile_pin, incarnation_id)
SELECT :route, :account_id, :subject_id, :requested_subject_id::nullable(uuid), :state, 1, input.time, input.time,
       :transaction_id, :library_profile_pin::nullable(jsonb), :incarnation_id::uuid
FROM input
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
          requested_subject_id AS "requestedSubjectId", incarnation_id AS "incarnationId", state, revision, created_at::text AS "createdAt",
          updated_at::text AS "updatedAt", transaction_id AS "transactionId";
