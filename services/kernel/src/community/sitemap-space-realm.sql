-- An occupied Space slot is public only when its exact current Realm head is active and public.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
), identity AS MATERIALIZED (
  SELECT h.route, h.realm_id, h.state, h.visibility, h.head_revision_id, h.created_at, i.at
  FROM community.realm AS h CROSS JOIN input i
  WHERE h.route = i.route AND h.realm_id = i.id
    AND h.state = 'active' AND h.visibility = 'public' AND h.created_at <= i.at
)
SELECT 1
FROM identity AS h CROSS JOIN input i
JOIN community.realm_revision AS r
  ON r.route = i.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
WHERE r.created_at <= h.at AND r.visibility = 'public'
LIMIT 1;
