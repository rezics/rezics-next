SELECT route, log_id AS id, account_id AS "accountId", session_id AS "sessionId", subject_id AS "subjectId",
       session_state AS "sessionState", started_at::text AS "startedAt", completed_at::text AS "completedAt", note,
       published_at::text AS "publishedAt", transaction_id AS "transactionId", revision, deleted,
       deletion_id AS "deletionId", deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil"
FROM library.published_log
WHERE route = :route AND log_id = :log_id;
