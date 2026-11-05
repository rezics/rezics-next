-- The exact native head must have been appended and moved by this settings transaction.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :author_id::uuid AS author_id
)
SELECT h.realm_id
FROM input i
JOIN community.realm h ON h.route = i.route AND h.realm_id = i.realm_id
JOIN community.realm_revision r
  ON r.route = i.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
WHERE h.state = 'active'
  AND h.xmin::text = pg_current_xact_id_if_assigned()::text
  AND r.xmin::text = pg_current_xact_id_if_assigned()::text
  AND r.predecessor IS NOT NULL AND r.author = i.author_id
LIMIT 1;
