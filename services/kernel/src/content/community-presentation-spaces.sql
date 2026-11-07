-- Keys are a JSON array bound as text so the reader never treats the list as a PostgreSQL array.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id FROM jsonb_to_recordset((:keys::text)::jsonb) AS k(route integer, id uuid)
)
SELECT h.route, h.space_id, h.head_revision_id, h.lifecycle_version::text, h.created_at, r.created_at AS revision_created_at,
       r.title, r.summary
FROM input i
CROSS JOIN LATERAL (
  SELECT h.* FROM community.space h
  WHERE h.route = i.route AND h.space_id = i.id AND h.state = 'active'
  LIMIT 1
) h
CROSS JOIN LATERAL (
  SELECT r.title, r.summary, r.created_at FROM community.space_revision r
  WHERE r.route = h.route AND r.space_id = h.space_id AND r.revision_id = h.head_revision_id
  LIMIT 1
) r;
