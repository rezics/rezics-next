SELECT route, realm_id
FROM community.realm
WHERE (route, realm_id) > (:route::integer, :id::uuid)
ORDER BY route, realm_id
LIMIT :limit::integer;
