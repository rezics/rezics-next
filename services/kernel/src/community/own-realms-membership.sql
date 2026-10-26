WITH input AS NOT MATERIALIZED (
  SELECT :at::timestamptz AS at
)
SELECT m.realm_id::text AS "realmId", r.title AS name, m.role
FROM community.realm_member AS m
CROSS JOIN input AS i
JOIN community.realm AS h
  ON h.route = m.route AND h.realm_id = m.realm_id AND h.state = 'active' AND h.created_at <= i.at
JOIN community.realm_revision AS r
  ON r.route = h.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
WHERE m.route = :route::integer
  AND m.realm_id = :realm_id::uuid
  AND m.account_id = :account_id::uuid
  AND m.role = 'member'
  AND (m.valid @> i.at) IS TRUE
  AND upper_inf(m.valid)
  AND r.created_at <= i.at
LIMIT 1;
