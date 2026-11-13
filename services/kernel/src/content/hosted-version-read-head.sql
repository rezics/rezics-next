SELECT snapshot.route,snapshot.catalogue_id,snapshot.generation_id,generation.generation_kind,
  snapshot.sequence::text AS sequence,snapshot.preorder_root_id,snapshot.chapter_root_id,
  snapshot.placement_count::text AS placement_count,snapshot.chapter_count::text AS chapter_count
FROM content.hosted_tree_generation generation
JOIN content.hosted_tree_snapshot_version snapshot
  ON snapshot.route=generation.route AND snapshot.catalogue_id=generation.catalogue_id
 AND snapshot.generation_id=generation.generation_id AND snapshot.sequence=generation.head_sequence
WHERE generation.route=$1 AND generation.catalogue_id=$2 AND generation.generation_id=$3
