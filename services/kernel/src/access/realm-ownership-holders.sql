WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
    :account_id::uuid AS account_id, :at::timestamptz AS at
)
SELECT EXISTS (
  SELECT 1 FROM access.resource_role_grant
  WHERE route = i.route AND resource_id = i.resource_id
    AND subject_kind = 'identity' AND subject_role = '' AND subject_id = i.account_id
    AND grant_role = 'community.realm.owner' AND valid @> i.at
) AS target, EXISTS (
  SELECT 1 FROM access.resource_role_grant
  WHERE route = i.route AND resource_id = i.resource_id
    AND subject_kind = 'identity' AND subject_role = '' AND subject_id <> i.account_id
    AND grant_role = 'community.realm.owner' AND valid @> i.at
    AND upper_inf(valid)
  LIMIT 1
) AS remaining
FROM input i;
