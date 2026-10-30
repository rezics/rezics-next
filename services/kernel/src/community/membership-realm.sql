SELECT realm_id::text AS "realmId"
FROM community.realm
WHERE route = :route::integer AND realm_id = :id::uuid
  AND state = 'active' AND created_at <= :at::timestamptz
FOR UPDATE;
