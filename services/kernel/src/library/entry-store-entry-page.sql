WITH args AS (
  SELECT :account_id::uuid AS account_id,
         :state::nullable(text) AS state,
         :after_updated_at::timestamptz AS after_updated_at,
         :after_subject_id::uuid AS after_subject_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
scoped AS NOT MATERIALIZED (
  SELECT entry.route,
         entry.account_id,
         entry.subject_id,
         entry.requested_subject_id,
         entry.incarnation_id,
         entry.state,
         entry.revision,
         entry.created_at,
         entry.updated_at,
         entry.transaction_id
  FROM library.entry AS entry
  WHERE entry.route = :route::integer
),
candidates AS (
(
  SELECT scoped.route,
         scoped.account_id AS "accountId",
         scoped.subject_id AS "subjectId",
         scoped.requested_subject_id AS "requestedSubjectId",
         scoped.incarnation_id AS "incarnationId",
         scoped.state,
         scoped.revision,
         scoped.created_at::text AS "createdAt",
         scoped.updated_at::text AS "updatedAt",
         scoped.transaction_id AS "transactionId"
  FROM scoped
  CROSS JOIN args
  WHERE scoped.account_id = args.account_id
    AND (args.state IS NULL OR scoped.state = args.state)
    AND (NOT args.has_cursor OR scoped.updated_at < args.after_updated_at)
  ORDER BY scoped.updated_at DESC, scoped.subject_id
  LIMIT (SELECT page_limit FROM args)
)
UNION ALL
(
  SELECT scoped.route,
         scoped.account_id AS "accountId",
         scoped.subject_id AS "subjectId",
         scoped.requested_subject_id AS "requestedSubjectId",
         scoped.incarnation_id AS "incarnationId",
         scoped.state,
         scoped.revision,
         scoped.created_at::text AS "createdAt",
         scoped.updated_at::text AS "updatedAt",
         scoped.transaction_id AS "transactionId"
  FROM scoped
  CROSS JOIN args
  WHERE scoped.account_id = args.account_id
    AND (args.state IS NULL OR scoped.state = args.state)
    AND args.has_cursor
    AND scoped.updated_at = args.after_updated_at
    AND scoped.subject_id > args.after_subject_id
  ORDER BY scoped.updated_at DESC, scoped.subject_id
  LIMIT (SELECT page_limit FROM args)
)
)
SELECT * FROM candidates
ORDER BY "updatedAt" DESC, "subjectId"
LIMIT (SELECT page_limit FROM args);
