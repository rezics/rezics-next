-- The unique Space slot is an exact key lookup, never a count of Realms.
WITH host AS MATERIALIZED (
  SELECT route, space_id FROM community.space
  WHERE route = :route::integer AND space_id = :space::uuid
    AND state = 'active' AND created_at <= :at::timestamptz
)
SELECT s.space_id, r.realm_id
FROM host s LEFT JOIN community.realm r ON r.route = s.route AND r.space_id = s.space_id;
