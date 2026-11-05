SELECT EXISTS (
  SELECT 1
  FROM access.resource_role_grant
  WHERE route = :route::integer AND resource_id = :resource_id::uuid
    AND subject_kind = 'identity' AND subject_id = :account_id::uuid AND subject_role = ''
    AND grant_role = :grant_role::text AND valid @> :at::timestamptz
) AS held;
