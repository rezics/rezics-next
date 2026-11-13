WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :generation_id::uuid AS generation_id,
         :after_cursor::jsonb AS after_cursor,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT node.index_kind,node.node_id,node.sequence
  FROM content.hosted_order_node_version node
  CROSS JOIN input
  WHERE node.route=input.route AND node.catalogue_id=input.catalogue_id
    AND node.generation_id=input.generation_id
    AND (
      input.after_cursor IS NULL OR
      ROW(node.index_kind,node.node_id,node.sequence) >
      ROW(input.after_cursor->>'indexKind',(input.after_cursor->>'nodeId')::uuid,
          (input.after_cursor->>'sequence')::bigint)
    )
  ORDER BY node.index_kind,node.node_id,node.sequence
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_order_node_version node
USING page,input
WHERE node.route=input.route AND node.catalogue_id=input.catalogue_id
  AND node.generation_id=input.generation_id AND node.index_kind=page.index_kind
  AND node.node_id=page.node_id AND node.sequence=page.sequence
RETURNING jsonb_build_object('kind','nodes','indexKind',node.index_kind,
  'nodeId',node.node_id::text,'sequence',node.sequence::text) AS cursor;
