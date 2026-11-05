SELECT valid::text AS valid
FROM access.resource_role_grant
WHERE route = :route::integer AND resource_id = :resource_id::uuid
  AND subject_kind = 'identity' AND subject_id = :account_id::uuid AND subject_role = ''
  AND grant_role = 'community.realm.owner' AND valid @> :at::timestamptz
  AND upper_inf(valid)
LIMIT 1;
