-- A body above the caller's admitted ceiling is never returned to the application.
SELECT id, subject, candidate, revision::double precision AS revision,
       CASE WHEN body IS NULL OR octet_length(body) <= :maximum_bytes::integer THEN body ELSE NULL END AS body,
       (body IS NOT NULL AND octet_length(body) > :maximum_bytes::integer) AS "bodyTooLarge",
       encode(body_sha256, 'hex') AS digest, source, rights, language, availability
FROM content.imported_field
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid]);
