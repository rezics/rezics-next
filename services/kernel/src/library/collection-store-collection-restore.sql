WITH input AS NOT MATERIALIZED (SELECT :time::timestamptz AS time)
UPDATE library.collection
SET state = 'active', deleted_at = NULL, purge_after = NULL, revision = revision + 1,
    source_generation = source_generation + 1,
    updated_at = input.time, transaction_id = :transaction_id
FROM input
WHERE route = :route AND collection_id = :id AND state = 'deleted' AND revision = :revision
  AND deleted_at IS NOT NULL AND input.time >= deleted_at AND input.time < purge_after
RETURNING collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, state,
          revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
