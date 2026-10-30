WITH input AS NOT MATERIALIZED (SELECT :time::timestamptz AS time)
UPDATE library.collection
SET state = 'deleted', revision = revision + 1, source_generation = source_generation + 1,
    updated_at = input.time, transaction_id = :transaction_id,
    deleted_at = input.time, purge_after = input.time + interval '720 hours'
FROM input
WHERE route = :route AND collection_id = :id AND state = 'active'
RETURNING collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, presentation_kind AS "presentationKind", cover_media_id AS "coverMediaId", state,
          revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
