SELECT route, account_id AS "accountId", subject_id AS "subjectId",
       requested_subject_id AS "requestedSubjectId", incarnation_id AS "incarnationId", state, revision, created_at::text AS "createdAt",
       updated_at::text AS "updatedAt", transaction_id AS "transactionId",
       library_profile_pin AS "libraryProfilePin"
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id;
