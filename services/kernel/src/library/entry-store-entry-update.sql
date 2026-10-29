UPDATE library.entry
SET state = :state, revision = revision + 1, updated_at = :time, transaction_id = :transaction_id,
    library_profile_pin = COALESCE(:library_profile_pin::nullable(jsonb), library_profile_pin)
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id AND revision = :revision
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
          requested_subject_id AS "requestedSubjectId", state, revision, created_at::text AS "createdAt",
          updated_at::text AS "updatedAt", transaction_id AS "transactionId";
