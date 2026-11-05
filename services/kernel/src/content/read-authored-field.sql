-- A collection result preserves absence for the low-level exact storage reader.
SELECT id, subject, anchor, candidate, revision::double precision AS revision, author_account_id, body,
       encode(body_sha256, 'hex') AS digest, licence, language, availability
FROM content.authored_field
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid]);
