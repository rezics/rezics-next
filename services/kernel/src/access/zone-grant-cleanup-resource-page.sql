SELECT erasure_key::text AS "afterKey", subject_kind AS "subjectKind",
subject_id::text AS "subjectId", subject_role AS "subjectRole"
FROM access.resource_grant
WHERE route = :route::integer AND resource_id = :zone_id::uuid
  AND erasure_key > :after_key::bigint
ORDER BY erasure_key
LIMIT :limit::integer;
