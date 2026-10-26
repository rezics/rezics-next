-- The unique Space slot is an exact key lookup, never a count of Realms.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :space::uuid AS space, :at::timestamptz AS at
), host AS MATERIALIZED (
  SELECT h.route, h.space_id FROM community.space AS h CROSS JOIN input i
  WHERE h.route = i.route AND h.space_id = i.space
    AND h.state = 'active' AND h.created_at <= i.at
)
SELECT s.space_id, r.realm_id
FROM host s CROSS JOIN input i
LEFT JOIN community.realm r ON r.route = i.route AND r.space_id = s.space_id
LIMIT 1;
