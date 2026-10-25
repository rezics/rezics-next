SELECT realm_id
FROM community.realm
WHERE route = :route::integer AND realm_id = :id::uuid
  AND state = 'active' AND created_at <= :at::timestamptz;
