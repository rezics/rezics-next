WITH page AS MATERIALIZED (
  SELECT source_order
  FROM content.hosted_publication_staging_candidate
  WHERE route=:route::integer AND catalogue_id=:catalogue_id::uuid
    AND stage_id=:stage_id::uuid AND source_order>:after_source_order::bigint
  ORDER BY source_order
  LIMIT :row_limit::integer
)
DELETE FROM content.hosted_publication_staging_candidate candidate
USING page
WHERE candidate.route=:route::integer AND candidate.catalogue_id=:catalogue_id::uuid
  AND candidate.stage_id=:stage_id::uuid AND candidate.source_order=page.source_order
RETURNING candidate.source_order::text AS source_order;
