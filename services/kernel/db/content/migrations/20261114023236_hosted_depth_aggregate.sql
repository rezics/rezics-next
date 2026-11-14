-- migrate:up
-- Store per-value depth and its AVL maximum beside immutable sequence nodes.
-- A NULL maximum marks older materialized trees whose cached aggregate must
-- be derived from the selected occurrence facts before editing.
ALTER TABLE content.hosted_order_node_version
  ADD COLUMN subtree_height smallint,
  ADD COLUMN maximum_subtree_height smallint,
  ADD COLUMN maximum_subtree_occurrence_id uuid,
  ADD CONSTRAINT hosted_order_node_depth_bounds
    CHECK (subtree_height IS NULL OR subtree_height BETWEEN 0 AND 16),
  ADD CONSTRAINT hosted_order_node_max_depth_bounds
    CHECK (maximum_subtree_height IS NULL OR maximum_subtree_height BETWEEN 0 AND 16),
  ADD CONSTRAINT hosted_order_node_max_depth_pair
    CHECK ((maximum_subtree_height IS NULL AND maximum_subtree_occurrence_id IS NULL)
        OR (maximum_subtree_height IS NOT NULL AND maximum_subtree_occurrence_id IS NOT NULL));

ALTER TABLE content.hosted_occurrence_state_version
  ADD COLUMN subtree_height smallint,
  ADD CONSTRAINT hosted_occurrence_state_depth_bounds
    CHECK (subtree_height IS NULL OR subtree_height BETWEEN 0 AND 16);

CREATE FUNCTION content.hosted_occurrence_subtree_height(encoded jsonb)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (
    SELECT (field.value->1->>'value')::smallint
    FROM jsonb_array_elements(
      CASE WHEN encoded->>'kind'='object' THEN encoded->'value' ELSE '[]'::jsonb END
    ) AS field(value)
    WHERE field.value->>0 = 'subtreeHeight'
    LIMIT 1
  )
$$;

CREATE INDEX hosted_occurrence_child_depth_asof
  ON content.hosted_occurrence_state_version
  (route, catalogue_id, generation_id, parent_occurrence_id,
   (COALESCE(subtree_height, content.hosted_occurrence_subtree_height(occurrence_state))) DESC,
   occurrence_id, sequence DESC)
  WHERE NOT is_deleted
    AND COALESCE(subtree_height, content.hosted_occurrence_subtree_height(occurrence_state)) IS NOT NULL;

-- migrate:down
DROP INDEX content.hosted_occurrence_child_depth_asof;
DROP FUNCTION content.hosted_occurrence_subtree_height(jsonb);
ALTER TABLE content.hosted_occurrence_state_version
  DROP CONSTRAINT hosted_occurrence_state_depth_bounds,
  DROP COLUMN subtree_height;
ALTER TABLE content.hosted_order_node_version
  DROP CONSTRAINT hosted_order_node_max_depth_pair,
  DROP CONSTRAINT hosted_order_node_max_depth_bounds,
  DROP CONSTRAINT hosted_order_node_depth_bounds,
  DROP COLUMN maximum_subtree_occurrence_id,
  DROP COLUMN maximum_subtree_height,
  DROP COLUMN subtree_height;
