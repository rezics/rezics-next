-- Exact current Space head and optional Realm head, locked on the Space row.
-- Join the intended revision rows so a dangling head pointer cannot publish.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :space_id::uuid AS space_id
)
SELECT s.head_revision_id::text AS space_revision, r.realm_id::text AS realm_id,
       r.head_revision_id::text AS realm_revision
FROM input i
JOIN community.space s ON s.route = i.route AND s.space_id = i.space_id
JOIN community.space_revision sv
  ON sv.route = s.route AND sv.space_id = s.space_id AND sv.revision_id = s.head_revision_id
LEFT JOIN community.realm r ON r.route = s.route AND r.space_id = s.space_id
LEFT JOIN community.realm_revision hv
  ON hv.route = r.route AND hv.realm_id = r.realm_id AND hv.revision_id = r.head_revision_id
WHERE (r.realm_id IS NULL OR hv.revision_id IS NOT NULL)
FOR UPDATE OF s
LIMIT 1;
