WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :generation_id::uuid AS generation_id, :after_index::nullable(text) AS after_index,
         :after_id::nullable(uuid) AS after_id, :after_sequence::nullable(text)::bigint AS after_sequence
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
  SELECT node.index_kind,node.node_id,node.sequence,node.title_redacted
  FROM input i CROSS JOIN LATERAL (
    SELECT index_kind,node_id,sequence,title_redacted FROM content.hosted_order_node_version
    WHERE route=i.route AND catalogue_id=i.catalogue_id AND generation_id=i.generation_id
      AND (index_kind,node_id,sequence)>(i.after_index,i.after_id,i.after_sequence)
    ORDER BY route,catalogue_id,generation_id,index_kind,node_id,sequence LIMIT 100
  ) node
  WHERE i.after_index IS NOT NULL
  UNION ALL
  SELECT node.index_kind,node.node_id,node.sequence,node.title_redacted
  FROM input i CROSS JOIN LATERAL (
    SELECT index_kind,node_id,sequence,title_redacted FROM content.hosted_order_node_version
    WHERE route=i.route AND catalogue_id=i.catalogue_id AND generation_id=i.generation_id
    ORDER BY route,catalogue_id,generation_id,index_kind,node_id,sequence LIMIT 100
  ) node
  WHERE i.after_index IS NULL
), changed AS (
  UPDATE content.hosted_order_node_version node
  SET node_state=content.redact_hosted_ordered_title(node.node_state,true),title_redacted=true
  FROM page CROSS JOIN input i CROSS JOIN private_generation
  WHERE node.route=i.route AND node.catalogue_id=i.catalogue_id
    AND node.generation_id=private_generation.generation_id AND node.index_kind=page.index_kind
    AND node.node_id=page.node_id AND node.sequence=page.sequence AND NOT page.title_redacted
    AND node.node_state IS DISTINCT FROM content.redact_hosted_ordered_title(node.node_state,true)
  RETURNING node.index_kind,node.node_id,node.sequence
)
SELECT page.index_kind,page.node_id AS row_id,page.sequence::text AS sequence,
       changed.node_id IS NOT NULL AS changed
FROM page LEFT JOIN changed USING(index_kind,node_id,sequence)
ORDER BY page.index_kind,page.node_id,page.sequence;
