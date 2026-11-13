WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :generation_id::uuid AS generation_id,
         :after_cursor::jsonb AS after_cursor,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT occurrence.occurrence_id,occurrence.sequence
  FROM content.hosted_occurrence_state_version occurrence
  CROSS JOIN input
  WHERE occurrence.route=input.route AND occurrence.catalogue_id=input.catalogue_id
    AND occurrence.generation_id=input.generation_id
    AND (
      input.after_cursor IS NULL OR
      ROW(occurrence.occurrence_id,occurrence.sequence) >
      ROW((input.after_cursor->>'occurrenceId')::uuid,(input.after_cursor->>'sequence')::bigint)
    )
  ORDER BY occurrence.occurrence_id,occurrence.sequence
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_occurrence_state_version occurrence
USING page,input
WHERE occurrence.route=input.route AND occurrence.catalogue_id=input.catalogue_id
  AND occurrence.generation_id=input.generation_id
  AND occurrence.occurrence_id=page.occurrence_id AND occurrence.sequence=page.sequence
RETURNING jsonb_build_object('kind','occurrences','occurrenceId',occurrence.occurrence_id::text,
  'sequence',occurrence.sequence::text) AS cursor;
