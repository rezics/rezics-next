WITH args AS (
  SELECT :account_id::uuid AS account_id,
         :target_type::text AS target_type,
         :after_updated_at::timestamptz AS after_updated_at,
         :after_target_id::uuid AS after_target_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
scoped AS NOT MATERIALIZED (
  SELECT follow.route,
         follow.account_id,
         follow.target_id,
         follow.target_type,
         follow.state,
         follow.reason,
         follow.created_at,
         follow.updated_at,
         follow.transaction_id
  FROM library.follow AS follow
  CROSS JOIN args
  WHERE follow.route = :route::integer
    AND (args.target_type IS NULL OR follow.target_type = args.target_type)
),
candidates AS (
(
  SELECT scoped.route,
         scoped.account_id AS "accountId",
         scoped.target_id AS "targetId",
         scoped.target_type AS "targetType",
         scoped.state,
         scoped.reason,
         scoped.created_at::text AS "createdAt",
         scoped.updated_at::text AS "updatedAt",
         scoped.transaction_id AS "transactionId"
  FROM scoped
  CROSS JOIN args
  WHERE scoped.account_id = args.account_id
    AND scoped.state = 'following'
    AND (NOT args.has_cursor OR scoped.updated_at < args.after_updated_at)
  ORDER BY scoped.updated_at DESC, scoped.target_id
  LIMIT (SELECT page_limit FROM args)
)
UNION ALL
(
  SELECT scoped.route,
         scoped.account_id AS "accountId",
         scoped.target_id AS "targetId",
         scoped.target_type AS "targetType",
         scoped.state,
         scoped.reason,
         scoped.created_at::text AS "createdAt",
         scoped.updated_at::text AS "updatedAt",
         scoped.transaction_id AS "transactionId"
  FROM scoped
  CROSS JOIN args
  WHERE scoped.account_id = args.account_id
    AND scoped.state = 'following'
    AND args.has_cursor
    AND scoped.updated_at = args.after_updated_at
    AND scoped.target_id > args.after_target_id
  ORDER BY scoped.updated_at DESC, scoped.target_id
  LIMIT (SELECT page_limit FROM args)
)
)
SELECT * FROM candidates
ORDER BY "updatedAt" DESC, "targetId"
LIMIT (SELECT page_limit FROM args);
