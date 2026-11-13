WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :stage_id::uuid AS stage_id,
         :after_input_position::bigint AS after_input_position,
         :row_limit::integer AS row_limit
),
page AS MATERIALIZED (
  SELECT staging_input.input_position
  FROM content.hosted_publication_staging_input staging_input
  CROSS JOIN input
  WHERE staging_input.route=input.route
    AND staging_input.catalogue_id=input.catalogue_id
    AND staging_input.stage_id=input.stage_id
    AND staging_input.input_position>input.after_input_position
  ORDER BY staging_input.input_position
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_publication_staging_input staging_input
USING page, input
WHERE staging_input.route=input.route
  AND staging_input.catalogue_id=input.catalogue_id
  AND staging_input.stage_id=input.stage_id
  AND staging_input.input_position=page.input_position
RETURNING staging_input.input_position::text AS input_position;
