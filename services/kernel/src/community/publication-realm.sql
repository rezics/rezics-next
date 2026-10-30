SELECT realm_id
FROM community.realm r
WHERE route = :route::integer AND realm_id = :id::uuid
  AND state = 'active'
  AND EXISTS (SELECT 1 FROM community.space s WHERE s.route=r.route AND s.space_id=r.space_id AND s.state='active') AND created_at <= :at::timestamptz;
