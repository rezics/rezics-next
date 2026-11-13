WITH generation AS (
  INSERT INTO content.hosted_tree_generation
    (route,catalogue_id,generation_id,generation_kind,head_sequence)
  VALUES ($1,$2,$3,$4,0)
  RETURNING route,catalogue_id,generation_id,generation_kind,head_sequence
), snapshot AS (
  INSERT INTO content.hosted_tree_snapshot_version
    (route,catalogue_id,generation_id,sequence,preorder_root_id,chapter_root_id,placement_count,chapter_count)
  SELECT route,catalogue_id,generation_id,0,NULL,NULL,0,0
  FROM generation
  RETURNING route,catalogue_id,generation_id,sequence
), root AS (
  INSERT INTO content.hosted_sibling_root_version
    (route,catalogue_id,generation_id,parent_id,parent_is_null,parent_key,sequence,root_node_id)
  SELECT route,catalogue_id,generation_id,NULL,true,'00000000-0000-0000-0000-000000000000',0,NULL
  FROM generation
  RETURNING route
)
SELECT route,catalogue_id,generation_id,generation_kind,head_sequence::text AS sequence,
  NULL::uuid AS preorder_root_id,NULL::uuid AS chapter_root_id,
  0::text AS placement_count,0::text AS chapter_count
FROM generation
