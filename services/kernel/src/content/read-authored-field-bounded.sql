-- A body above the caller's admitted ceiling is never returned to the application.
SELECT id, subject, anchor, candidate, revision::double precision AS revision, author_account_id,
       CASE WHEN body IS NULL OR octet_length(body) <= :maximum_bytes::integer THEN body ELSE NULL END AS body,
       (body IS NOT NULL AND octet_length(body) > :maximum_bytes::integer) AS "bodyTooLarge",
       encode(body_sha256, 'hex') AS digest, licence, language, availability
FROM content.authored_field
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid]);
