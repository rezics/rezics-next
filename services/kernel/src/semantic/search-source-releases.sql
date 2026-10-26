SELECT digest, body
FROM semantic.definition_release
WHERE route = :route::integer AND digest = ANY(:digests::text[]);
