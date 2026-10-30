WITH args AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :curator_account_id::uuid AS curator_account_id,
         :after_updated_at::timestamptz AS after_updated_at,
         :after_id::uuid AS after_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
candidates AS (
  (
    SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId", collection.title,
           collection.description, collection.visibility, collection.presentation_kind AS "presentationKind",
           collection.cover_media_id AS "coverMediaId", collection.source_generation::text AS "sourceGeneration", collection.membership_kind AS "membershipKind", collection.revision, collection.member_count AS "memberCount",
           collection.created_at::text AS "createdAt", collection.updated_at::text AS "updatedAt",
           collection.updated_at AS "updatedAtOrder",
           COALESCE(to_char(collection.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS "updatedAtExact"
    FROM library.collection AS collection
      CROSS JOIN args
    WHERE collection.route = args.route
      AND collection.curator_account_id = args.curator_account_id
      AND collection.state = 'active'
      AND collection.visibility = 'public'
      AND collection.updated_at < CASE WHEN args.has_cursor THEN args.after_updated_at ELSE 'infinity'::timestamptz END
    ORDER BY collection.updated_at DESC, collection.collection_id DESC
    LIMIT (SELECT page_limit FROM args)
  )
  UNION ALL
  (
    SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId", collection.title,
           collection.description, collection.visibility, collection.presentation_kind AS "presentationKind",
           collection.cover_media_id AS "coverMediaId", collection.source_generation::text AS "sourceGeneration", collection.membership_kind AS "membershipKind", collection.revision, collection.member_count AS "memberCount",
           collection.created_at::text AS "createdAt", collection.updated_at::text AS "updatedAt",
           collection.updated_at AS "updatedAtOrder",
           COALESCE(to_char(collection.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS "updatedAtExact"
    FROM library.collection AS collection
      CROSS JOIN args
    WHERE collection.route = args.route
      AND collection.curator_account_id = args.curator_account_id
      AND collection.state = 'active'
      AND collection.visibility = 'public'
      AND args.has_cursor
      AND collection.updated_at = args.after_updated_at
      AND collection.collection_id < args.after_id
    ORDER BY collection.updated_at DESC, collection.collection_id DESC
    LIMIT (SELECT page_limit FROM args)
  )
)
SELECT id, "curatorAccountId", title, description, visibility, "presentationKind", "coverMediaId", "sourceGeneration", "membershipKind", revision, "memberCount",
       "createdAt", "updatedAt", "updatedAtExact"
FROM candidates
ORDER BY "updatedAtOrder" DESC, id DESC
LIMIT (SELECT page_limit FROM args);
