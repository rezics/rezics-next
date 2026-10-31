SELECT pg_column_size(body)::text AS bytes, pg_column_compression(body) IS NOT NULL AS compressed
FROM semantic.definition_release
WHERE route = 0 AND digest = :digest;
