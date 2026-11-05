SELECT 1 FROM access.resource_role_grant
WHERE route = :route::integer AND resource_id = :id::uuid
  AND subject_kind = 'identity' AND subject_id = :account_id::uuid AND subject_role = ''
  AND grant_role = 'semantic.zone.owner' AND valid @> :at::timestamptz
LIMIT 1;
