-- Two proofs: owner is always a negative range from T, member is the current
-- interval or the gap until the next finite lower bound. A missing or not-yet
-- active Realm yields no row.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id,
         :account_id::uuid AS account_id, :at::timestamptz AS at
)
SELECT r.role,
       (r.role = 'member' AND m.valid IS NOT NULL) AS member,
       COALESCE(
         m.valid,
         tstzrange(i.at, CASE WHEN r.role = 'member' THEN n.starts_at END, '[)')
       )::text AS valid
FROM input i
JOIN community.realm realm
  ON realm.route = i.route AND realm.realm_id = i.realm_id
 AND realm.state = 'active' AND realm.created_at <= i.at
CROSS JOIN (VALUES ('owner'), ('member')) AS r(role)
LEFT JOIN community.realm_member m
  ON r.role = 'member' AND m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
 AND m.valid @> i.at
LEFT JOIN LATERAL (
  SELECT lower(f.valid) AS starts_at
  FROM community.realm_member f
  WHERE f.route = i.route AND f.realm_id = i.realm_id AND f.account_id = i.account_id
    AND r.role = 'member' AND NOT lower_inf(f.valid) AND lower(f.valid) > i.at
  ORDER BY lower(f.valid)
  LIMIT 1
) n ON m.valid IS NULL;
