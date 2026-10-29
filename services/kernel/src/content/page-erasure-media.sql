-- One exact retained revision holds at most 32 media references. Resolve only
-- actual owned rows, not arbitrary references, container scans or author media.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :post_id::uuid AS post_id, :revision_id::uuid AS revision_id
), owned AS MATERIALIZED (
  SELECT m.route, m.media_id, m.container_id, m.erased
  FROM input i
  JOIN content.revision r ON r.route = i.route AND r.post_id = i.post_id AND r.revision_id = i.revision_id
  JOIN content.post p ON p.route = i.route AND p.post_id = i.post_id
  CROSS JOIN LATERAL unnest(r.media_ids) AS ref(media_id)
  JOIN content.media m ON m.route = i.route AND m.media_id = ref.media_id
  WHERE p.availability = 'erased'
    AND m.claimed_item_id = p.post_id
    AND m.uploader_id = p.author_account_id
    AND m.container_id IN (p.post_id, p.thread_id, p.reply_to_post_id)
    AND NOT m.collection_pending
  ORDER BY m.media_id
  LIMIT 100
  FOR UPDATE OF m
), changed AS (
  UPDATE content.media m
  SET erased = true, security_revision = security_revision + 1
  FROM owned o CROSS JOIN input i
  WHERE m.route = i.route AND m.route = o.route AND m.media_id = o.media_id AND NOT o.erased
  RETURNING m.media_id
)
SELECT o.media_id, o.container_id, NOT o.erased AS changed
FROM owned o LEFT JOIN changed c ON c.media_id = o.media_id
ORDER BY o.media_id;
