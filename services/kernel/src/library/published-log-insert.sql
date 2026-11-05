INSERT INTO library.published_log
  (route, log_id, account_id, session_id, subject_id, session_state, started_at, completed_at, note, published_at,
   transaction_id)
VALUES
  (:route, :log_id, :account_id, :session_id, :subject_id, :session_state, :started_at::timestamptz,
   :completed_at::nullable(timestamptz), :note::nullable(text), :published_at::timestamptz, :transaction_id)
RETURNING route, log_id AS id, account_id AS "accountId", session_id AS "sessionId", subject_id AS "subjectId",
       session_state AS "sessionState", started_at::text AS "startedAt", completed_at::text AS "completedAt", note,
       published_at::text AS "publishedAt", transaction_id AS "transactionId", revision, deleted,
       deletion_id AS "deletionId", deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil";
