SELECT space_id::text AS "spaceId"
FROM community.realm
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND state = 'active' AND created_at <= :at::timestamptz;
