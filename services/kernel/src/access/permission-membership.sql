WITH parameters AS MATERIALIZED (
  SELECT :pairs::nullable(jsonb) AS pairs, :at::timestamptz AS at, :route::integer AS route,
    :organization_id::uuid AS organization_id, :member_id::uuid AS member_id
), input AS MATERIALIZED (
  SELECT r.route, r.organization_id, r.member_id, p.at
  FROM parameters p CROSS JOIN jsonb_to_recordset(p.pairs) AS r(route integer, organization_id uuid, member_id uuid)
  UNION ALL
  SELECT p.route, p.organization_id, p.member_id, p.at FROM parameters p WHERE p.pairs IS NULL
)
SELECT i.member_id::text AS "accountId", i.organization_id::text AS "organizationId", a.kind, a.state, a.authn_fenced AS fenced, r.role,
       (a.state = 'active' AND NOT a.authn_fenced AND m.valid IS NOT NULL) AS member,
       (CASE WHEN a.state = 'active' AND NOT a.authn_fenced
         THEN COALESCE(m.valid, tstzrange(i.at, n.starts_at, '[)'))
         ELSE tstzrange(i.at, NULL, '[)') END)::text AS valid
FROM input i
JOIN LATERAL (
  SELECT a.kind, a.state, a.authn_fenced FROM access.account a
  WHERE a.route = i.route AND a.account_id = i.organization_id LIMIT 1
) a ON true
CROSS JOIN (VALUES ('owner'), ('member')) r(role)
LEFT JOIN LATERAL (
  SELECT m.valid FROM access.organization_member m
  WHERE m.route = i.route AND m.organization_id = i.organization_id AND m.member_account_id = i.member_id
    AND m.role = r.role AND m.valid @> i.at LIMIT 1
) m ON true
LEFT JOIN LATERAL (
  SELECT lower(f.valid) AS starts_at FROM access.organization_member f
  WHERE f.route = i.route AND f.organization_id = i.organization_id AND f.member_account_id = i.member_id
    AND f.role = r.role AND NOT lower_inf(f.valid) AND lower(f.valid) > i.at
  ORDER BY lower(f.valid) LIMIT 1
) n ON m.valid IS NULL;
