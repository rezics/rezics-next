SELECT EXISTS (
  SELECT 1 FROM access.resource_role_grant
  WHERE route = :route::integer AND resource_id = :resource_id::uuid
    AND subject_kind = 'identity' AND subject_role = ''
    AND grant_role = 'community.realm.owner' AND valid @> :at::timestamptz
  LIMIT 1
) AS held;
