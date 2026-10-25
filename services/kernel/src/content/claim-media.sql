WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :media_ids::uuid[] AS media_ids,
         :container_id::uuid AS container_id, :uploader_id::uuid AS uploader_id, :at::timestamptz AS at
), locked AS MATERIALIZED (
  SELECT m.route, m.media_id, m.container_id, m.uploader_id, m.state, m.erased, m.collection_pending, m.claimed_at
  FROM content.media m CROSS JOIN input i
  WHERE m.route = i.route AND m.media_id = ANY(i.media_ids)
  ORDER BY m.media_id
  FOR UPDATE OF m
), valid AS MATERIALIZED (
  SELECT m.route, m.media_id, m.claimed_at FROM locked m CROSS JOIN input i
  WHERE m.container_id = i.container_id AND m.uploader_id = i.uploader_id
    AND m.state = 'available' AND NOT m.erased AND NOT m.collection_pending
), changed AS (
  UPDATE content.media m
  SET claimed_at = i.at
  FROM valid v CROSS JOIN input i
  WHERE m.route = i.route AND m.route = v.route AND m.media_id = v.media_id
    AND v.claimed_at IS NULL
  RETURNING m.media_id
)
SELECT media_id FROM valid;
