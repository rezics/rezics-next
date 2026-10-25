SELECT collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, state,
       revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
       created_at::text AS "createdAt", updated_at::text AS "updatedAt"
FROM library.collection
WHERE route = :route AND collection_id = :id
LIMIT 1;
