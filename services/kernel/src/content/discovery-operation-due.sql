SELECT route, intent, generation::text
FROM content.realm_discovery_operation
WHERE route = :route::integer AND NOT projected AND phase IN ('applied','aborted')
ORDER BY intent, generation LIMIT :limit::integer;
