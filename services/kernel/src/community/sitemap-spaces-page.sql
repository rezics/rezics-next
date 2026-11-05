SELECT route, space_id
FROM community.space
WHERE (route, space_id) > (:route::integer, :id::uuid)
ORDER BY route, space_id
LIMIT :limit::integer;
