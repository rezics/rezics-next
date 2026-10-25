SELECT digest, head
FROM semantic.definition_activation
WHERE route = :route::integer
ORDER BY head DESC
LIMIT 1;
