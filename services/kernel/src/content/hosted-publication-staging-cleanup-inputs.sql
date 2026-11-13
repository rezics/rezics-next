WITH page AS MATERIALIZED (
  SELECT input_position
  FROM content.hosted_publication_staging_input
  WHERE route=:route::integer AND catalogue_id=:catalogue_id::uuid
    AND stage_id=:stage_id::uuid AND input_position>:after_input_position::bigint
  ORDER BY input_position
  LIMIT :row_limit::integer
)
DELETE FROM content.hosted_publication_staging_input input
USING page
WHERE input.route=:route::integer AND input.catalogue_id=:catalogue_id::uuid
  AND input.stage_id=:stage_id::uuid AND input.input_position=page.input_position
RETURNING input.input_position::text AS input_position;
