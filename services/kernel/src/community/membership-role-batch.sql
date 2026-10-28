-- unbound: trusted admitted Realm/account pairs use exact anchors across routes before resource checkout.
-- Two proofs: owner is always a negative range from T, member is the current
-- interval or the gap until the next finite lower bound. A missing or not-yet
-- active Realm yields no row.
WITH parameters AS MATERIALIZED (
  SELECT :at::timestamptz AS at, :pairs::jsonb AS pairs
), input AS MATERIALIZED (
  SELECT r.route, r.realm_id, r.account_id, p.at
  FROM parameters p
  CROSS JOIN jsonb_to_recordset(p.pairs) AS r(route integer, realm_id uuid, account_id uuid)
)
SELECT i.realm_id::text AS "realmId", i.account_id::text AS "accountId", r.role,
       (r.role = 'member' AND m.valid IS NOT NULL) AS member,
       COALESCE(
         m.valid,
         tstzrange(i.at, CASE WHEN r.role = 'member' THEN n.starts_at END, '[)')
       )::text AS valid
FROM input i
JOIN LATERAL (
  SELECT realm.realm_id FROM community.realm realm
  WHERE realm.route = i.route AND realm.realm_id = i.realm_id
    AND realm.state = 'active' AND realm.created_at <= i.at
  LIMIT 1
) realm ON true
CROSS JOIN (VALUES ('owner'), ('member')) AS r(role)
LEFT JOIN LATERAL (
  SELECT m.valid FROM community.realm_member m
  WHERE r.role = 'member' AND m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
    AND m.valid @> i.at
  LIMIT 1
) m ON true
LEFT JOIN LATERAL (
  SELECT lower(f.valid) AS starts_at
  FROM community.realm_member f
  WHERE f.route = i.route AND f.realm_id = i.realm_id AND f.account_id = i.account_id
    AND r.role = 'member' AND NOT lower_inf(f.valid) AND lower(f.valid) > i.at
  ORDER BY lower(f.valid)
  LIMIT 1
) n ON m.valid IS NULL;
