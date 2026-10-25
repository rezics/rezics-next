WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :member_id::uuid AS member_id, :at::timestamptz AS at
)
SELECT a.kind, a.state, m.role, m.valid::text AS valid
FROM input i
JOIN access.account a ON a.route = i.route AND a.account_id = i.organization_id
LEFT JOIN access.organization_member m
  ON m.route = i.route AND m.organization_id = i.organization_id AND m.member_account_id = i.member_id
  AND m.valid && tstzrange(i.at, 'infinity');
