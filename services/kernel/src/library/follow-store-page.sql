WITH args AS (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :after_updated_at::timestamptz AS after_updated_at,
         :after_target_id::uuid AS after_target_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
candidates AS (
(
  SELECT follow.route,
         follow.account_id AS "accountId",
         follow.target_id AS "targetId",
         follow.target_type AS "targetType",
         follow.state,
         follow.reason,
         follow.created_at::text AS "createdAt",
         follow.updated_at::text AS "updatedAt",
         follow.transaction_id AS "transactionId"
  FROM library.follow AS follow
  CROSS JOIN args
  WHERE follow.route = args.route
    AND follow.account_id = args.account_id
    AND follow.state = 'following'
    AND (NOT args.has_cursor OR follow.updated_at < args.after_updated_at)
  ORDER BY follow.updated_at DESC, follow.target_id
  LIMIT (SELECT page_limit FROM args)
)
UNION ALL
(
  SELECT follow.route,
         follow.account_id AS "accountId",
         follow.target_id AS "targetId",
         follow.target_type AS "targetType",
         follow.state,
         follow.reason,
         follow.created_at::text AS "createdAt",
         follow.updated_at::text AS "updatedAt",
         follow.transaction_id AS "transactionId"
  FROM library.follow AS follow
  CROSS JOIN args
  WHERE follow.route = args.route
    AND follow.account_id = args.account_id
    AND follow.state = 'following'
    AND args.has_cursor
    AND follow.updated_at = args.after_updated_at
    AND follow.target_id > args.after_target_id
  ORDER BY follow.updated_at DESC, follow.target_id
  LIMIT (SELECT page_limit FROM args)
)
)
SELECT * FROM candidates
ORDER BY "updatedAt" DESC, "targetId"
LIMIT (SELECT page_limit FROM args);
