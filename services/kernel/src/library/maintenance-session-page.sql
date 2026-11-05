SELECT session_id AS "sessionId",
       subject_id AS "subjectId",
       state,
       revision,
       transaction_id AS "transactionId",
       COALESCE(to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS "startedAt",
       to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "completedAt",
       to_char(last_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastChangedAt"
FROM library.progress_session
WHERE state <> 'retired' AND route = :route::integer
  AND account_id = :account_id::uuid
  AND session_id > :after::uuid
ORDER BY session_id
LIMIT :page_limit::integer;
