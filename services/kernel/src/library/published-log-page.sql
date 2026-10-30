WITH args AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :after_published_at::timestamptz AS after_published_at,
         :after_log_id::uuid AS after_log_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
candidates AS (
(
  SELECT log.route,
         log.log_id AS id,
         log.account_id AS "accountId",
         log.session_id AS "sessionId",
         log.subject_id AS "subjectId",
         log.session_state AS "sessionState",
         log.started_at::text AS "startedAt",
         log.completed_at::text AS "completedAt",
         log.note,
         log.published_at::text AS "publishedAt",
         log.transaction_id AS "transactionId",
         log.published_at AS sort_at
  FROM library.published_log AS log
  CROSS JOIN args
  WHERE log.route = args.route
    AND log.account_id = args.account_id
    AND NOT log.deleted
    AND (NOT args.has_cursor OR log.published_at < args.after_published_at)
  ORDER BY log.published_at DESC, log.log_id
  LIMIT (SELECT page_limit FROM args)
)
UNION ALL
(
  SELECT log.route,
         log.log_id AS id,
         log.account_id AS "accountId",
         log.session_id AS "sessionId",
         log.subject_id AS "subjectId",
         log.session_state AS "sessionState",
         log.started_at::text AS "startedAt",
         log.completed_at::text AS "completedAt",
         log.note,
         log.published_at::text AS "publishedAt",
         log.transaction_id AS "transactionId",
         log.published_at AS sort_at
  FROM library.published_log AS log
  CROSS JOIN args
  WHERE log.route = args.route
    AND log.account_id = args.account_id
    AND NOT log.deleted
    AND args.has_cursor
    AND log.published_at = args.after_published_at
    AND log.log_id > args.after_log_id
  ORDER BY log.published_at DESC, log.log_id
  LIMIT (SELECT page_limit FROM args)
)
)
SELECT route, id, "accountId", "sessionId", "subjectId", "sessionState", "startedAt", "completedAt", note,
       "publishedAt", "transactionId"
FROM candidates
ORDER BY sort_at DESC, id
LIMIT (SELECT page_limit FROM args);
