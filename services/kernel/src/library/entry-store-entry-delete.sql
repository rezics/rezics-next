DELETE FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id AND revision = :revision
  AND (:expected_incarnation_id::nullable(uuid) IS NULL OR incarnation_id = :expected_incarnation_id::nullable(uuid))
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
          requested_subject_id AS "requestedSubjectId", incarnation_id AS "incarnationId", state, revision, created_at::text AS "createdAt",
          updated_at::text AS "updatedAt", transaction_id AS "transactionId";
