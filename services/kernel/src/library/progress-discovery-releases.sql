SELECT digest, body
FROM semantic.definition_release
WHERE route = 0 AND digest = ANY(:digests::text[])
ORDER BY digest
LIMIT 50;
