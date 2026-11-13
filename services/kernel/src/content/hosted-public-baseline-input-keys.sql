-- Read only a bounded raw ordinal interval plus one continuation sentinel.
SELECT p.ordinal::text AS ordinal
FROM content.hosted_placement p
WHERE p.route=:route::integer AND p.catalogue_id=:catalogue_id::uuid
  AND p.revision_id=:publication_id::uuid AND p.ordinal>:after_ordinal::integer
ORDER BY p.ordinal
LIMIT :limit::integer;
