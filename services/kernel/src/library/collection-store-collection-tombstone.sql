UPDATE library.collection
SET state = 'deleted', revision = revision + 1, updated_at = :time, transaction_id = :transaction_id
WHERE route = :route AND collection_id = :id AND state = 'active'
RETURNING collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, state,
          revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
