WITH args AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :curator_account_id::uuid AS curator_account_id,
         :public_only::boolean AS public_only,
         :after_updated_at::timestamptz AS after_updated_at,
         :after_id::uuid AS after_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
candidates AS (
  (
    SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId", collection.title,
           collection.description, collection.visibility, collection.revision, collection.member_count AS "memberCount",
           collection.created_at::text AS "createdAt", collection.updated_at::text AS "updatedAt",
           COALESCE(to_char(collection.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS "updatedAtExact"
    FROM library.collection AS collection
      CROSS JOIN args
    WHERE collection.route = args.route
      AND collection.curator_account_id = args.curator_account_id
      AND collection.state = 'active'
      AND (NOT args.public_only OR collection.visibility = 'public')
      AND (NOT args.has_cursor OR collection.updated_at < args.after_updated_at)
    ORDER BY collection.updated_at DESC, collection.collection_id DESC
    LIMIT (SELECT page_limit FROM args)
  )
  UNION ALL
  (
    SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId", collection.title,
           collection.description, collection.visibility, collection.revision, collection.member_count AS "memberCount",
           collection.created_at::text AS "createdAt", collection.updated_at::text AS "updatedAt",
           COALESCE(to_char(collection.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS "updatedAtExact"
    FROM library.collection AS collection
      CROSS JOIN args
    WHERE collection.route = args.route
      AND collection.curator_account_id = args.curator_account_id
      AND collection.state = 'active'
      AND (NOT args.public_only OR collection.visibility = 'public')
      AND args.has_cursor
      AND collection.updated_at = args.after_updated_at
      AND collection.collection_id < args.after_id
    ORDER BY collection.updated_at DESC, collection.collection_id DESC
    LIMIT (SELECT page_limit FROM args)
  )
)
SELECT * FROM candidates
ORDER BY "updatedAtExact" DESC, id DESC
LIMIT (SELECT page_limit FROM args);
