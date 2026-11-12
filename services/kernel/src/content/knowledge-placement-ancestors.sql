WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :notebook_id::uuid AS notebook_id,
         :placement_id::uuid AS placement_id,
         :maximum_depth::integer AS maximum_depth
), ancestor(placement_id, parent_id, depth) AS (
  SELECT placement.placement_id, placement.parent_id, 0
  FROM content.knowledge_placement placement
  CROSS JOIN input
  WHERE placement.route=input.route
    AND placement.notebook_id=input.notebook_id
    AND placement.placement_id=input.placement_id
  UNION ALL
  SELECT parent.placement_id, parent.parent_id, child.depth+1
  FROM ancestor child
  CROSS JOIN input
  JOIN content.knowledge_placement parent
    ON parent.route=input.route
   AND parent.notebook_id=input.notebook_id
   AND parent.placement_id=child.parent_id
  WHERE child.depth<input.maximum_depth
)
SELECT placement_id, parent_id, depth FROM ancestor ORDER BY depth;
