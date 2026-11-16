SELECT p.source_ordinal::text AS source_ordinal,
  p.occurrence_id,
  p.parent_id,
  p.position::text AS position,
  p.kind,
  p.title,
  p.target_thread_id,
  p.target_post_id,
  p.target_revision_id,
  encode(p.target_sha256, 'hex') AS target_sha256
FROM content.hosted_version_builder_point p
WHERE p.route = $1
  AND p.catalogue_id = $2
  AND p.input_id = $3
  AND p.source_ordinal < $4::bigint
ORDER BY p.source_ordinal DESC
LIMIT $5
