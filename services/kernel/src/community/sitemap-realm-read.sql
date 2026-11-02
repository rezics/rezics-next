-- Exact native source and carried host, all in the source's home partition.
-- Materialized identities prevent head joins from walking revision history.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
), realm AS MATERIALIZED (
  SELECT h.route, h.realm_id, h.space_id, h.head_revision_id, h.lifecycle_version, i.at
  FROM community.realm h CROSS JOIN input i
  WHERE h.route = i.route AND h.realm_id = i.id
    AND h.state = 'active' AND h.visibility = 'public' AND h.created_at <= i.at
), host AS MATERIALIZED (
  SELECT s.route, s.space_id, s.head_revision_id, s.lifecycle_version
  FROM realm h CROSS JOIN input i
  JOIN community.space s ON s.route = i.route AND s.space_id = h.space_id
  WHERE s.state = 'active' AND s.created_at <= i.at
)
SELECT h.head_revision_id, s.space_id, s.head_revision_id AS space_head_revision_id, sr.address,
       h.lifecycle_version::text AS realm_version, s.lifecycle_version::text AS space_version,
       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision_created_at,
       to_char(sr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS space_revision_created_at
FROM realm h CROSS JOIN input i
JOIN community.realm_revision r
  ON r.route = i.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
JOIN host s ON s.route = i.route AND s.space_id = h.space_id
JOIN community.space_revision sr
  ON sr.route = i.route AND sr.space_id = s.space_id AND sr.revision_id = s.head_revision_id
WHERE r.visibility = 'public' AND r.created_at <= h.at AND sr.created_at <= h.at
LIMIT 1;
