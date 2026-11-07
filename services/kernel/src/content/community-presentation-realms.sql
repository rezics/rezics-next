-- Keys are a JSON array bound as text so the reader never treats the list as a PostgreSQL array.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id FROM jsonb_to_recordset((:keys::text)::jsonb) AS k(route integer, id uuid)
)
SELECT h.route, h.realm_id, h.space_id, h.context_id, h.visibility, h.head_revision_id, h.lifecycle_version::text,
       h.created_at, r.created_at AS revision_created_at, r.title, r.summary, r.presentation
FROM input i
CROSS JOIN LATERAL (
  SELECT h.* FROM community.realm h
  WHERE h.route = i.route AND h.realm_id = i.id AND h.state = 'active'
  LIMIT 1
) h
CROSS JOIN LATERAL (
  SELECT r.title, r.summary, r.presentation, r.created_at FROM community.realm_revision r
  WHERE r.route = h.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
  LIMIT 1
) r;
