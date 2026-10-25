SELECT digest, head
FROM presentation.profile_activation
WHERE route = :route::integer
ORDER BY head DESC
LIMIT 1;
