WITH advanced AS (
  UPDATE content.hosted_tree_generation generation
  SET head_sequence=$4::bigint
  WHERE generation.route=$1 AND generation.catalogue_id=$2 AND generation.generation_id=$3
    AND generation.head_sequence=$5::bigint AND $4::bigint=$5::bigint+1
  RETURNING generation.route,generation.catalogue_id,generation.generation_id,generation.head_sequence
), node_rows AS (
  INSERT INTO content.hosted_order_node_version
    (route,catalogue_id,generation_id,index_kind,node_id,sequence,tree_parent_id,node_state,is_deleted)
  SELECT head.route,head.catalogue_id,head.generation_id,node.index_kind,node.node_id,head.head_sequence,
    node.tree_parent_id,node.node_state,node.is_deleted
  FROM advanced head
  CROSS JOIN LATERAL jsonb_to_recordset($6::jsonb) AS node(
    index_kind text,node_id uuid,tree_parent_id uuid,node_state jsonb,is_deleted boolean
  )
  RETURNING node_id
), occurrence_rows AS (
  INSERT INTO content.hosted_occurrence_state_version
    (route,catalogue_id,generation_id,occurrence_id,sequence,parent_occurrence_id,subtree_size,occurrence_state,is_deleted)
  SELECT head.route,head.catalogue_id,head.generation_id,occurrence.occurrence_id,head.head_sequence,
    occurrence.parent_occurrence_id,occurrence.subtree_size,occurrence.occurrence_state,occurrence.is_deleted
  FROM advanced head
  CROSS JOIN LATERAL jsonb_to_recordset($7::jsonb) AS occurrence(
    occurrence_id uuid,parent_occurrence_id uuid,subtree_size bigint,occurrence_state jsonb,is_deleted boolean
  )
  RETURNING occurrence_id
), sibling_roots AS (
  INSERT INTO content.hosted_sibling_root_version
    (route,catalogue_id,generation_id,parent_id,parent_is_null,parent_key,sequence,root_node_id)
  SELECT head.route,head.catalogue_id,head.generation_id,root.parent_id,root.parent_is_null,root.parent_key,
    head.head_sequence,root.root_node_id
  FROM advanced head
  CROSS JOIN LATERAL jsonb_to_recordset($8::jsonb) AS root(
    parent_id uuid,parent_is_null boolean,parent_key uuid,root_node_id uuid
  )
  RETURNING parent_key
), snapshot_row AS (
  INSERT INTO content.hosted_tree_snapshot_version
    (route,catalogue_id,generation_id,sequence,preorder_root_id,chapter_root_id,placement_count,chapter_count)
  SELECT head.route,head.catalogue_id,head.generation_id,head.head_sequence,
    $9::uuid,$10::uuid,$11::bigint,$12::bigint
  FROM advanced head
  RETURNING sequence
)
SELECT head.head_sequence::text AS sequence FROM advanced head
