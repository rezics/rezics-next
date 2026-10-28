UPDATE library.collection
SET title = :title, description = :description::nullable(text), visibility = :visibility, revision = revision + 1,
    source_generation = source_generation + CASE WHEN visibility IS DISTINCT FROM :visibility THEN 1 ELSE 0 END,
    updated_at = :time, transaction_id = :transaction_id
WHERE route = :route AND collection_id = :id AND revision = :revision AND state = 'active'
RETURNING collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, state,
          revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
