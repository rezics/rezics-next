WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :generation_id::uuid AS generation_id,
         :after_cursor::jsonb AS after_cursor,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT root.parent_is_null,root.parent_key,root.sequence
  FROM content.hosted_sibling_root_version root
  CROSS JOIN input
  WHERE root.route=input.route AND root.catalogue_id=input.catalogue_id
    AND root.generation_id=input.generation_id
    AND (
      input.after_cursor IS NULL OR
      ROW(root.parent_is_null,root.parent_key,root.sequence) >
      ROW((input.after_cursor->>'parentIsNull')::boolean,
          (input.after_cursor->>'parentKey')::uuid,(input.after_cursor->>'sequence')::bigint)
    )
  ORDER BY root.parent_is_null,root.parent_key,root.sequence
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_sibling_root_version root
USING page,input
WHERE root.route=input.route AND root.catalogue_id=input.catalogue_id
  AND root.generation_id=input.generation_id AND root.parent_is_null=page.parent_is_null
  AND root.parent_key=page.parent_key AND root.sequence=page.sequence
RETURNING jsonb_build_object('kind','sibling_roots','parentIsNull',root.parent_is_null,
  'parentKey',root.parent_key::text,'sequence',root.sequence::text) AS cursor;
