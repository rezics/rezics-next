-- A body above the caller's admitted ceiling is never returned to the application.
WITH input AS (SELECT :maximum_bytes::integer AS maximum_bytes)
SELECT id, subject, candidate, revision::double precision AS revision,
       CASE WHEN body IS NULL OR octet_length(body) <= input.maximum_bytes THEN body ELSE NULL END AS body,
       (body IS NOT NULL AND octet_length(body) > input.maximum_bytes) AS "bodyTooLarge",
       encode(body_sha256, 'hex') AS digest, source, rights, language, availability
FROM content.imported_field
CROSS JOIN input
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid]);
