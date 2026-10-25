WITH args AS (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :state::nullable(text) AS state,
         :after_updated_at::timestamptz AS after_updated_at,
         :after_subject_id::uuid AS after_subject_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
candidates AS (
(
  SELECT entry.route,
         entry.account_id AS "accountId",
         entry.subject_id AS "subjectId",
         entry.requested_subject_id AS "requestedSubjectId",
         entry.state,
         entry.revision,
         entry.created_at::text AS "createdAt",
         entry.updated_at::text AS "updatedAt",
         entry.transaction_id AS "transactionId"
  FROM library.entry AS entry
  CROSS JOIN args
  WHERE entry.route = args.route
    AND entry.account_id = args.account_id
    AND (args.state IS NULL OR entry.state = args.state)
    AND (NOT args.has_cursor OR entry.updated_at < args.after_updated_at)
  ORDER BY entry.updated_at DESC, entry.subject_id
  LIMIT (SELECT page_limit FROM args)
)
UNION ALL
(
  SELECT entry.route,
         entry.account_id AS "accountId",
         entry.subject_id AS "subjectId",
         entry.requested_subject_id AS "requestedSubjectId",
         entry.state,
         entry.revision,
         entry.created_at::text AS "createdAt",
         entry.updated_at::text AS "updatedAt",
         entry.transaction_id AS "transactionId"
  FROM library.entry AS entry
  CROSS JOIN args
  WHERE entry.route = args.route
    AND entry.account_id = args.account_id
    AND (args.state IS NULL OR entry.state = args.state)
    AND args.has_cursor
    AND entry.updated_at = args.after_updated_at
    AND entry.subject_id > args.after_subject_id
  ORDER BY entry.updated_at DESC, entry.subject_id
  LIMIT (SELECT page_limit FROM args)
)
)
SELECT * FROM candidates
ORDER BY "updatedAt" DESC, "subjectId"
LIMIT (SELECT page_limit FROM args);
