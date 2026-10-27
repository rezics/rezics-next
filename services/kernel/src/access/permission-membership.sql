WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :member_id::uuid AS member_id, :at::timestamptz AS at
)
SELECT a.kind, a.state, a.authn_fenced AS fenced, r.role,
       (a.state = 'active' AND NOT a.authn_fenced AND m.valid IS NOT NULL) AS member,
       (CASE WHEN a.state = 'active' AND NOT a.authn_fenced
         THEN COALESCE(m.valid, tstzrange(i.at, n.starts_at, '[)'))
         ELSE tstzrange(i.at, NULL, '[)') END)::text AS valid
FROM input i
JOIN access.account a ON a.route = i.route AND a.account_id = i.organization_id
CROSS JOIN (VALUES ('owner'), ('member')) r(role)
LEFT JOIN access.organization_member m
  ON m.route = i.route AND m.organization_id = i.organization_id AND m.member_account_id = i.member_id
  AND m.role = r.role AND m.valid @> i.at
LEFT JOIN LATERAL (
  SELECT lower(f.valid) AS starts_at FROM access.organization_member f
  WHERE f.route = i.route AND f.organization_id = i.organization_id AND f.member_account_id = i.member_id
    AND f.role = r.role AND NOT lower_inf(f.valid) AND lower(f.valid) > i.at
  ORDER BY lower(f.valid) LIMIT 1
) n ON m.valid IS NULL;
