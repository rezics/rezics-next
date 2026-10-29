WITH input AS (SELECT :expected_incarnation_id::nullable(uuid) AS expected_incarnation_id)
DELETE FROM library.entry
USING input
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id AND revision = :revision
  AND (input.expected_incarnation_id IS NULL OR incarnation_id = input.expected_incarnation_id)
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
          requested_subject_id AS "requestedSubjectId", incarnation_id AS "incarnationId", state, revision, created_at::text AS "createdAt",
          updated_at::text AS "updatedAt", transaction_id AS "transactionId";
