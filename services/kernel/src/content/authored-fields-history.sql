-- Immutable native association metadata only, including retained erased rows.
SELECT id, subject, candidate, revision::double precision AS revision
FROM content.authored_field
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid]);
