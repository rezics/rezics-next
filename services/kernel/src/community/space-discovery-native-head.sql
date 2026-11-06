-- One unavailable Space with no pending tuple work, at its intended native heads.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :space_id::uuid AS space_id
)
SELECT s.head_revision_id AS space_revision, r.realm_id, r.head_revision_id AS realm_revision
FROM input i
JOIN community.space_discovery_tuple_witness w ON w.route = i.route AND w.space_id = i.space_id
JOIN community.space s ON s.route = w.route AND s.space_id = w.space_id
JOIN community.space_revision v
  ON v.route = s.route AND v.space_id = s.space_id AND v.revision_id = s.head_revision_id
LEFT JOIN community.realm r ON r.route = s.route AND r.space_id = s.space_id
LEFT JOIN community.realm_revision h
  ON h.route = r.route AND h.realm_id = r.realm_id AND h.revision_id = r.head_revision_id
WHERE w.state = 'unavailable'
  AND (r.realm_id IS NULL OR h.revision_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM community.space_discovery_tuple_work t
    WHERE t.route = w.route AND t.space_id = w.space_id
  )
LIMIT 1;
