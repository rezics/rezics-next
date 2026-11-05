WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
    :account_id::uuid AS account_id, :at::timestamptz AS at, :roles::text[] AS roles
)
SELECT r.role, CASE r.role
  WHEN 'community.realm.owner' THEN 4
  WHEN 'community.realm.administrator' THEN 3
  WHEN 'community.realm.moderator' THEN 2
  ELSE 1
END::integer AS rank, g.valid::text AS valid
FROM input i CROSS JOIN unnest(i.roles) WITH ORDINALITY r(role, ordinality)
CROSS JOIN LATERAL (
  SELECT g.valid FROM access.resource_role_grant g
  WHERE g.route = i.route AND g.resource_id = i.resource_id
    AND g.subject_kind = 'identity' AND g.subject_id = i.account_id AND g.subject_role = ''
    AND g.grant_role = r.role AND g.valid @> i.at
  LIMIT 1
) g
WHERE EXISTS (
  SELECT 1 FROM access.resource_initialization
  WHERE route = i.route AND resource_id = i.resource_id AND resource_type = 'community.realm'
)
ORDER BY r.ordinality;
