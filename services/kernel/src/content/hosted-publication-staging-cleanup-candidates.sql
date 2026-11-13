WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :stage_id::uuid AS stage_id,
         :after_source_order::bigint AS after_source_order,
         :row_limit::integer AS row_limit
),
page AS MATERIALIZED (
  SELECT candidate.source_order
  FROM content.hosted_publication_staging_candidate candidate
  CROSS JOIN input
  WHERE candidate.route=input.route AND candidate.catalogue_id=input.catalogue_id
    AND candidate.stage_id=input.stage_id
    AND candidate.source_order>input.after_source_order
  ORDER BY candidate.source_order
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_publication_staging_candidate candidate
USING page, input
WHERE candidate.route=input.route AND candidate.catalogue_id=input.catalogue_id
  AND candidate.stage_id=input.stage_id AND candidate.source_order=page.source_order
RETURNING candidate.source_order::text AS source_order;
