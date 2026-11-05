WITH input AS (SELECT :visibility::nullable(text) AS visibility, :after::nullable(uuid) AS after_id)
SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId", collection.title,
       collection.description, collection.visibility, collection.presentation_kind AS "presentationKind",
       collection.cover_media_id AS "coverMediaId", collection.state, collection.revision,
       collection.member_count AS "memberCount", collection.order_epoch AS "orderEpoch",
       collection.created_at::text AS "createdAt", collection.updated_at::text AS "updatedAt"
FROM library.collection AS collection
  CROSS JOIN input
WHERE collection.route = :route AND collection.curator_account_id = :curator_account_id AND collection.state = 'active'
  AND (input.visibility IS NULL OR collection.visibility = input.visibility)
  AND (input.after_id IS NULL OR collection.collection_id > input.after_id)
ORDER BY collection.collection_id
LIMIT :limit;
