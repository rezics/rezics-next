SELECT id, subject, candidate, revision::double precision AS revision
FROM content.imported_field
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid]);
