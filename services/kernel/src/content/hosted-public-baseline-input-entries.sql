-- Hydrate only the selected ordinal interval, never the continuation sentinel.
SELECT p.ordinal::text AS ordinal,p.occurrence_id,p.parent_id,p.position,p.title,p.title_redacted,
       o.kind,o.thread_id,o.post_id,p.target_revision_id,encode(p.body_sha256,'hex') AS sha256
FROM content.hosted_placement p
JOIN content.hosted_occurrence o
  ON o.route=p.route AND o.catalogue_id=p.catalogue_id AND o.occurrence_id=p.occurrence_id
WHERE p.route=:route::integer AND p.catalogue_id=:catalogue_id::uuid
  AND p.revision_id=:publication_id::uuid
  AND p.ordinal>:after_ordinal::integer AND p.ordinal<=:through_ordinal::integer
ORDER BY p.ordinal
LIMIT :limit::integer;
