WITH RECURSIVE ancestor(placement_id, parent_id, depth) AS (
  SELECT placement_id, parent_id, 0
  FROM content.knowledge_placement
  WHERE route=:route AND notebook_id=:notebook_id AND placement_id=:placement_id
  UNION ALL
  SELECT parent.placement_id, parent.parent_id, child.depth+1
  FROM ancestor child
  JOIN content.knowledge_placement parent
    ON parent.route=:route AND parent.notebook_id=:notebook_id AND parent.placement_id=child.parent_id
  WHERE child.depth < :maximum_depth
)
SELECT placement_id, parent_id, depth FROM ancestor ORDER BY depth;
