WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :generation_id::uuid AS generation_id,
         :after_cursor::jsonb AS after_cursor,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT snapshot.sequence
  FROM content.hosted_tree_snapshot_version snapshot
  CROSS JOIN input
  WHERE snapshot.route=input.route AND snapshot.catalogue_id=input.catalogue_id
    AND snapshot.generation_id=input.generation_id
    AND (input.after_cursor IS NULL OR
      snapshot.sequence>(input.after_cursor->>'sequence')::bigint)
  ORDER BY snapshot.sequence
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_tree_snapshot_version snapshot
USING page,input
WHERE snapshot.route=input.route AND snapshot.catalogue_id=input.catalogue_id
  AND snapshot.generation_id=input.generation_id AND snapshot.sequence=page.sequence
RETURNING jsonb_build_object('kind','snapshots','sequence',snapshot.sequence::text) AS cursor;
