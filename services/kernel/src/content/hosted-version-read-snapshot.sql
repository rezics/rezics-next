SELECT snapshot.route,snapshot.catalogue_id,snapshot.generation_id,generation.generation_kind,
  snapshot.sequence::text AS sequence,snapshot.preorder_root_id,snapshot.chapter_root_id,
  snapshot.placement_count::text AS placement_count,snapshot.chapter_count::text AS chapter_count
FROM content.hosted_tree_snapshot_version snapshot
JOIN content.hosted_tree_generation generation
  USING (route,catalogue_id,generation_id)
WHERE snapshot.route=$1 AND snapshot.catalogue_id=$2 AND snapshot.generation_id=$3
  AND snapshot.sequence=$4
