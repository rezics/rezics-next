-- The publication's unique ordinal index gives its raw manifest bound without
-- counting or walking the release. A missing row is a valid empty manifest.
SELECT p.ordinal::text AS ordinal
FROM content.hosted_placement p
WHERE p.route=:route::integer AND p.catalogue_id=:catalogue_id::uuid
  AND p.revision_id=:publication_id::uuid
ORDER BY p.ordinal DESC
LIMIT 1;
