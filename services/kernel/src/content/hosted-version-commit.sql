WITH write_input AS (
  SELECT
    $1::integer AS route,
    $2::uuid AS catalogue_id,
    $3::uuid AS generation_id,
    $4::bigint AS next_sequence,
    $5::bigint AS expected_sequence,
    $6::jsonb AS node_rows,
    $7::jsonb AS occurrence_rows,
    $8::jsonb AS sibling_root_rows,
    $9::uuid AS preorder_root_id,
    $10::uuid AS chapter_root_id,
    $11::bigint AS placement_count,
    $12::bigint AS chapter_count
), advanced AS (
  UPDATE content.hosted_tree_generation generation
  SET head_sequence=write_input.next_sequence
  FROM write_input
  WHERE generation.route=write_input.route
    AND generation.catalogue_id=write_input.catalogue_id
    AND generation.generation_id=write_input.generation_id
    AND generation.head_sequence=write_input.expected_sequence
    AND write_input.next_sequence=write_input.expected_sequence+1
  RETURNING generation.route,generation.catalogue_id,generation.generation_id,generation.head_sequence
), node_rows AS (
  INSERT INTO content.hosted_order_node_version
    (route,catalogue_id,generation_id,index_kind,node_id,sequence,tree_parent_id,node_state,is_deleted)
  SELECT head.route,head.catalogue_id,head.generation_id,node.index_kind,node.node_id,head.head_sequence,
    node.tree_parent_id,node.node_state,node.is_deleted
  FROM advanced head
  CROSS JOIN write_input
  CROSS JOIN LATERAL jsonb_to_recordset(write_input.node_rows) AS node(
    index_kind text,node_id uuid,tree_parent_id uuid,node_state jsonb,is_deleted boolean
  )
  RETURNING node_id
), occurrence_rows AS (
  INSERT INTO content.hosted_occurrence_state_version
    (route,catalogue_id,generation_id,occurrence_id,sequence,parent_occurrence_id,subtree_size,occurrence_state,is_deleted)
  SELECT head.route,head.catalogue_id,head.generation_id,occurrence.occurrence_id,head.head_sequence,
    occurrence.parent_occurrence_id,occurrence.subtree_size,occurrence.occurrence_state,occurrence.is_deleted
  FROM advanced head
  CROSS JOIN write_input
  CROSS JOIN LATERAL jsonb_to_recordset(write_input.occurrence_rows) AS occurrence(
    occurrence_id uuid,parent_occurrence_id uuid,subtree_size bigint,occurrence_state jsonb,is_deleted boolean
  )
  RETURNING occurrence_id
), sibling_roots AS (
  INSERT INTO content.hosted_sibling_root_version
    (route,catalogue_id,generation_id,parent_id,parent_is_null,parent_key,sequence,root_node_id)
  SELECT head.route,head.catalogue_id,head.generation_id,root.parent_id,root.parent_is_null,root.parent_key,
    head.head_sequence,root.root_node_id
  FROM advanced head
  CROSS JOIN write_input
  CROSS JOIN LATERAL jsonb_to_recordset(write_input.sibling_root_rows) AS root(
    parent_id uuid,parent_is_null boolean,parent_key uuid,root_node_id uuid
  )
  RETURNING parent_key
), snapshot_row AS (
  INSERT INTO content.hosted_tree_snapshot_version
    (route,catalogue_id,generation_id,sequence,preorder_root_id,chapter_root_id,placement_count,chapter_count)
  SELECT head.route,head.catalogue_id,head.generation_id,head.head_sequence,
    write_input.preorder_root_id,write_input.chapter_root_id,write_input.placement_count,write_input.chapter_count
  FROM advanced head
  CROSS JOIN write_input
  RETURNING sequence
)
SELECT head.head_sequence::text AS sequence FROM advanced head
