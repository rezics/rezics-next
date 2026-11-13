SELECT source_ordinal::text AS source_ordinal,
  occurrence_id,
  parent_id,
  position::text AS position,
  kind,
  title,
  target_thread_id,
  target_post_id,
  target_revision_id,
  encode(target_sha256, 'hex') AS target_sha256
FROM content.hosted_version_builder_point
WHERE route = $1
  AND catalogue_id = $2
  AND input_id = $3
  AND source_ordinal < $4::bigint
ORDER BY source_ordinal DESC
LIMIT $5
