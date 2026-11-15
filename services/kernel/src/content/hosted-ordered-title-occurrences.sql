WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :generation_id::uuid AS generation_id, :after_id::nullable(uuid) AS after_id,
         :after_sequence::nullable(text)::bigint AS after_sequence
), private_generation AS MATERIALIZED (
  SELECT generation.generation_id FROM content.hosted_tree_generation generation CROSS JOIN input i
  WHERE generation.route=i.route AND generation.catalogue_id=i.catalogue_id
    AND generation.generation_id=i.generation_id
    AND NOT EXISTS (
      SELECT 1 FROM content.hosted_version_revision revision
      WHERE revision.route=i.route AND revision.catalogue_id=i.catalogue_id
        AND revision.generation_id=i.generation_id AND revision.revision_kind='publication'
      LIMIT 1
    )
  FOR UPDATE OF generation
), page AS MATERIALIZED (
  SELECT occurrence.occurrence_id,occurrence.sequence,occurrence.title_redacted
  FROM input i CROSS JOIN LATERAL (
    SELECT occurrence_id,sequence,title_redacted FROM content.hosted_occurrence_state_version
    WHERE route=i.route AND catalogue_id=i.catalogue_id AND generation_id=i.generation_id
      AND (occurrence_id,sequence)>(i.after_id,i.after_sequence)
    ORDER BY route,catalogue_id,generation_id,occurrence_id,sequence LIMIT 100
  ) occurrence
  WHERE i.after_id IS NOT NULL
  UNION ALL
  SELECT occurrence.occurrence_id,occurrence.sequence,occurrence.title_redacted
  FROM input i CROSS JOIN LATERAL (
    SELECT occurrence_id,sequence,title_redacted FROM content.hosted_occurrence_state_version
    WHERE route=i.route AND catalogue_id=i.catalogue_id AND generation_id=i.generation_id
    ORDER BY route,catalogue_id,generation_id,occurrence_id,sequence LIMIT 100
  ) occurrence
  WHERE i.after_id IS NULL
), changed AS (
  UPDATE content.hosted_occurrence_state_version occurrence
  SET occurrence_state=content.redact_hosted_ordered_title(occurrence.occurrence_state,false),title_redacted=true
  FROM page CROSS JOIN input i CROSS JOIN private_generation
  WHERE occurrence.route=i.route AND occurrence.catalogue_id=i.catalogue_id
    AND occurrence.generation_id=private_generation.generation_id
    AND occurrence.occurrence_id=page.occurrence_id AND occurrence.sequence=page.sequence
    AND NOT page.title_redacted
    AND occurrence.occurrence_state IS DISTINCT FROM content.redact_hosted_ordered_title(occurrence.occurrence_state,false)
  RETURNING occurrence.occurrence_id,occurrence.sequence
)
SELECT page.occurrence_id AS row_id,page.sequence::text AS sequence,
       changed.occurrence_id IS NOT NULL AS changed
FROM page LEFT JOIN changed USING(occurrence_id,sequence)
ORDER BY page.occurrence_id,page.sequence;
