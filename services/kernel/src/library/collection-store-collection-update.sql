WITH input AS NOT MATERIALIZED (SELECT :visibility::text AS new_visibility)
UPDATE library.collection
SET presentation_kind = CASE WHEN :set_presentation_kind::boolean THEN :presentation_kind::nullable(text) ELSE presentation_kind END,
    cover_media_id = CASE WHEN :set_cover_media_id::boolean THEN :cover_media_id::nullable(uuid) ELSE cover_media_id END,
    title = :title, description = :description::nullable(text), visibility = (SELECT new_visibility FROM input), revision = revision + 1,
    source_generation = source_generation + CASE WHEN visibility IS DISTINCT FROM (SELECT new_visibility FROM input) THEN 1 ELSE 0 END,
    updated_at = :time, transaction_id = :transaction_id
WHERE route = :route AND collection_id = :id AND revision = :revision AND state = 'active'
RETURNING collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, presentation_kind AS "presentationKind", cover_media_id AS "coverMediaId", state,
          revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
