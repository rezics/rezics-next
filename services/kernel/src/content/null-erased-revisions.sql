-- Caller supplies permanent erasure or an expired tombstone fence. Exact revision index keys;
-- original IDs, licences and media references remain unchanged.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :post_id::uuid AS post_id
), page AS MATERIALIZED (
  SELECT r.route, r.post_id, r.revision_id, r.recorded_at,
         r.availability = 'available' AS changed
  FROM content.revision r CROSS JOIN input i
  WHERE r.route = i.route AND r.post_id = i.post_id
    AND (r.recorded_at, r.revision_id) > (:after_at::timestamptz, :after_id::uuid)
    AND EXISTS (SELECT 1 FROM content.post p
                WHERE p.route = i.route AND p.post_id = i.post_id
                  AND p.availability = 'erased')
  ORDER BY r.recorded_at, r.revision_id
  LIMIT 100
), cleared AS (
  UPDATE content.revision r
  SET body = NULL, body_sha256 = NULL, search_text = NULL, availability = 'erased'
  FROM page p CROSS JOIN input i
  WHERE r.route = i.route AND r.post_id = i.post_id
    AND (r.recorded_at, r.revision_id) >= (
      SELECT recorded_at, revision_id FROM page ORDER BY recorded_at, revision_id LIMIT 1
    )
    AND (r.recorded_at, r.revision_id) <= (
      SELECT recorded_at, revision_id FROM page ORDER BY recorded_at DESC, revision_id DESC LIMIT 1
    )
    AND r.route = p.route AND r.post_id = p.post_id
    AND r.recorded_at = p.recorded_at AND r.revision_id = p.revision_id
    AND p.changed AND r.availability = 'available'
  RETURNING r.revision_id
)
SELECT p.revision_id, p.recorded_at::text AS at, c.revision_id IS NOT NULL AS changed
FROM page p
LEFT JOIN cleared c ON c.revision_id = p.revision_id
ORDER BY p.recorded_at, p.revision_id;
