WITH input AS (SELECT :time::timestamptz AS time)
INSERT INTO library.collection
  (route, collection_id, curator_account_id, title, description, visibility, presentation_kind, cover_media_id, state, revision, member_count,
   order_epoch, created_at, updated_at, transaction_id)
SELECT :route, :id, :curator_account_id, :title, :description::nullable(text), :visibility, :presentation_kind::nullable(text), :cover_media_id::nullable(uuid), 'active', 1, 0, 0,
       input.time, input.time, :transaction_id
FROM input
RETURNING collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility, presentation_kind AS "presentationKind", cover_media_id AS "coverMediaId", state,
          revision, member_count AS "memberCount", order_epoch AS "orderEpoch",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
