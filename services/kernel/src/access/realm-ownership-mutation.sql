WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
    :account_id::uuid AS account_id, :previous_valid::tstzrange AS previous_valid,
    :retains_owner::boolean AS retains_owner, :valid::tstzrange AS valid, :at::timestamptz AS at
)
SELECT EXISTS (
  SELECT 1 FROM access.resource_initialization
  WHERE route = i.route AND resource_id = i.resource_id AND resource_type = 'community.realm'
) AS realm, EXISTS (
  SELECT 1 FROM access.resource_role_grant
  WHERE route = i.route AND resource_id = i.resource_id
    AND subject_kind = 'identity' AND subject_id = i.account_id AND subject_role = ''
    AND grant_role = 'community.realm.owner' AND valid = i.previous_valid
    AND valid @> i.at
) AS current, (i.retains_owner AND i.valid @> i.at AND upper_inf(i.valid)) AS retained
FROM input i;
