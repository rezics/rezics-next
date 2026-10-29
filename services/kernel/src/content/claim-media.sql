WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :media_ids::uuid[] AS media_ids,
         :container_id::uuid AS container_id, :uploader_id::uuid AS uploader_id, :at::timestamptz AS at,
         :item_id::uuid AS item_id, :revision_id::uuid AS revision_id,
         :authorization_resource_id::uuid AS authorization_resource_id, :new_thread::boolean AS new_thread
), locked AS MATERIALIZED (
  SELECT m.route, m.media_id, m.container_id, m.uploader_id, m.purpose, m.state,
         m.erased, m.collection_pending, m.taken_down, m.claimed_at, m.claimed_item_id
  FROM content.media m CROSS JOIN input i
  WHERE m.route = i.route AND m.media_id = ANY(i.media_ids)
  ORDER BY m.media_id
  FOR UPDATE OF m
), valid AS MATERIALIZED (
  SELECT m.route, m.media_id, m.claimed_at, m.claimed_item_id FROM locked m CROSS JOIN input i
  WHERE m.container_id = i.container_id AND m.uploader_id = i.uploader_id
    AND m.purpose = 'post-image' AND m.state = 'available'
    AND (m.claimed_item_id IS NULL OR m.claimed_item_id = i.item_id)
    AND NOT m.erased AND NOT m.collection_pending AND NOT m.taken_down
    AND EXISTS (
      SELECT 1 FROM content.post p
      JOIN content.revision r ON r.route = i.route AND r.revision_id = i.revision_id
        AND r.post_id = p.post_id AND r.thread_id = p.thread_id
      JOIN content.thread t ON t.route = i.route AND t.thread_id = p.thread_id
      WHERE p.route = i.route AND p.post_id = i.item_id
        AND (
          (i.new_thread AND i.container_id = p.thread_id AND i.authorization_resource_id = t.board_id)
          OR
          (NOT i.new_thread AND i.container_id IN (p.thread_id, p.post_id, p.reply_to_post_id)
            AND i.authorization_resource_id IN (p.thread_id, p.post_id, p.reply_to_post_id))
        )
        AND p.availability = 'available' AND p.visibility <> 'taken_down' AND r.availability = 'available'
    )
), changed AS (
  UPDATE content.media m
  SET claimed_at = COALESCE(v.claimed_at, i.at), claimed_item_id = i.item_id
  FROM valid v CROSS JOIN input i
  WHERE m.route = i.route AND m.route = v.route AND m.media_id = v.media_id
    AND v.claimed_item_id IS NULL
  RETURNING m.media_id
)
SELECT media_id FROM valid;
