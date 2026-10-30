WITH args AS (SELECT :time::timestamptz AS time)
UPDATE library.published_log AS log
SET deleted = true, revision = revision + 1, deletion_id = :deletion_id::uuid,
    deleted_at = args.time, restore_until = args.time + interval '720 hours',
    transaction_id = :transaction_id::uuid
FROM args
WHERE route = :route AND log_id = :log_id AND account_id = :account_id
  AND NOT deleted AND revision = :revision::integer AND revision <= 2147483644
RETURNING route, log_id AS id, account_id AS "accountId", session_id AS "sessionId", subject_id AS "subjectId",
       session_state AS "sessionState", started_at::text AS "startedAt", completed_at::text AS "completedAt", note,
       published_at::text AS "publishedAt", transaction_id AS "transactionId", revision, deleted,
       deletion_id AS "deletionId", deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil";
