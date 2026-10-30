UPDATE library.published_log
SET deleted = false, revision = revision + 1, deletion_id = NULL, deleted_at = NULL, restore_until = NULL,
    transaction_id = :transaction_id::uuid
WHERE route = :route AND log_id = :log_id AND account_id = :account_id
  AND deleted AND deletion_id = :deletion_id::uuid AND revision = :revision::integer
  AND :time::timestamptz < restore_until AND revision < 2147483646
RETURNING route, log_id AS id, account_id AS "accountId", session_id AS "sessionId", subject_id AS "subjectId",
       session_state AS "sessionState", started_at::text AS "startedAt", completed_at::text AS "completedAt", note,
       published_at::text AS "publishedAt", transaction_id AS "transactionId", revision, deleted,
       deletion_id AS "deletionId", deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil";
