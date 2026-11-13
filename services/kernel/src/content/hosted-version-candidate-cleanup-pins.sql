WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :stage_id::uuid AS stage_id,
         :generation_id::uuid AS generation_id
), pins AS (
  SELECT 'retained revision'::text AS pin_kind
  FROM content.hosted_version_revision revision
  CROSS JOIN input
  WHERE revision.route=input.route AND revision.catalogue_id=input.catalogue_id
    AND revision.generation_id=input.generation_id

  UNION ALL

  SELECT 'current pointer'::text
  FROM content.hosted_catalogue catalogue
  JOIN content.hosted_version_revision revision
    ON revision.route=catalogue.route AND revision.catalogue_id=catalogue.catalogue_id
   AND revision.revision_id IN (catalogue.head_revision_id,catalogue.publication_id)
  CROSS JOIN input
  WHERE catalogue.route=input.route AND catalogue.catalogue_id=input.catalogue_id
    AND revision.generation_id=input.generation_id

  UNION ALL

  SELECT 'draft activation checkpoint'::text
  FROM content.hosted_version_draft_activation activation
  CROSS JOIN input
  WHERE activation.route=input.route AND activation.catalogue_id=input.catalogue_id
    AND activation.generation_id=input.generation_id

  UNION ALL

  SELECT 'public baseline checkpoint'::text
  FROM content.hosted_version_public_baseline baseline
  CROSS JOIN input
  WHERE baseline.route=input.route AND baseline.catalogue_id=input.catalogue_id
    AND baseline.generation_id=input.generation_id

  UNION ALL

  SELECT 'other release candidate checkpoint'::text
  FROM content.hosted_version_release_candidate candidate
  CROSS JOIN input
  WHERE candidate.route=input.route AND candidate.catalogue_id=input.catalogue_id
    AND candidate.generation_id=input.generation_id AND candidate.stage_id<>input.stage_id

  UNION ALL

  SELECT 'active ordered receiving hold'::text
  FROM content.hosted_publication_staging stage
  CROSS JOIN input
  WHERE stage.route=input.route AND stage.catalogue_id=input.catalogue_id
    AND stage.source_kind='ordered' AND stage.source_ordered_generation_id=input.generation_id
    AND stage.status NOT IN ('cancelled','expired','failed')
)
SELECT pin_kind FROM pins LIMIT 1;
