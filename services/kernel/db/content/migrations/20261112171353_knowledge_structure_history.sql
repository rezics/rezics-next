-- Knowledge revisions retain ordered sibling roots and immutable placement deltas. The live adjacency table
-- remains the current read model; a move path-copies only the old and new sibling trees.
-- migrate:up
ALTER TABLE content.knowledge_notebook
  ADD COLUMN structure_revision_number bigint NOT NULL DEFAULT 1 CHECK (structure_revision_number > 0);

ALTER TABLE content.knowledge_structure_revision
  ADD COLUMN revision_number bigint NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  ADD COLUMN history_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN change_kind text NOT NULL DEFAULT 'legacy';

WITH ranked AS (
  SELECT revision.route,
         revision.notebook_id,
         revision.revision_id,
         row_number() OVER (
           PARTITION BY revision.route, revision.notebook_id
           ORDER BY (revision.revision_id = notebook.structure_revision_id), revision.created_at, revision.revision_id
         ) AS revision_number
  FROM content.knowledge_structure_revision revision
  JOIN content.knowledge_notebook notebook
    ON notebook.route = revision.route AND notebook.notebook_id = revision.notebook_id
)
UPDATE content.knowledge_structure_revision revision
SET revision_number = ranked.revision_number
FROM ranked
WHERE ranked.route = revision.route
  AND ranked.notebook_id = revision.notebook_id
  AND ranked.revision_id = revision.revision_id;

UPDATE content.knowledge_structure_revision revision
SET history_complete = true,
    change_kind = 'baseline'
FROM content.knowledge_notebook notebook
WHERE notebook.route = revision.route
  AND notebook.notebook_id = revision.notebook_id
  AND notebook.structure_revision_id = revision.revision_id;

UPDATE content.knowledge_notebook notebook
SET structure_revision_number = revision.revision_number
FROM content.knowledge_structure_revision revision
WHERE revision.route = notebook.route
  AND revision.notebook_id = notebook.notebook_id
  AND revision.revision_id = notebook.structure_revision_id;

ALTER TABLE content.knowledge_structure_revision
  ADD CONSTRAINT knowledge_structure_revision_number_key UNIQUE (route, notebook_id, revision_number);

ALTER TABLE content.knowledge_placement
  ALTER COLUMN position TYPE numeric(38, 0) USING position::numeric * 1000000,
  ADD COLUMN subtree_height smallint NOT NULL DEFAULT 0 CHECK (subtree_height BETWEEN 0 AND 31);

ALTER TABLE content.knowledge_placement
  DROP CONSTRAINT knowledge_placement_route_notebook_id_parent_id_position_key;
ALTER TABLE content.knowledge_placement
  ADD CONSTRAINT knowledge_placement_route_notebook_id_parent_id_position_key
    UNIQUE NULLS NOT DISTINCT (route, notebook_id, parent_id, position)
    DEFERRABLE INITIALLY DEFERRED;

WITH RECURSIVE descendants(route, notebook_id, ancestor_id, descendant_id, depth) AS (
  SELECT placement.route, placement.notebook_id, placement.placement_id, placement.placement_id, 0
  FROM content.knowledge_placement placement
  UNION ALL
  SELECT descendants.route,
         descendants.notebook_id,
         descendants.ancestor_id,
         child.placement_id,
         descendants.depth + 1
  FROM descendants
  JOIN content.knowledge_placement child
    ON child.route = descendants.route
   AND child.notebook_id = descendants.notebook_id
   AND child.parent_id = descendants.descendant_id
  WHERE descendants.depth < 31
), heights AS (
  SELECT route, notebook_id, ancestor_id AS placement_id, max(depth)::smallint AS subtree_height
  FROM descendants
  GROUP BY route, notebook_id, descendant_id
)
UPDATE content.knowledge_placement placement
SET subtree_height = heights.subtree_height
FROM heights
WHERE heights.route = placement.route
  AND heights.notebook_id = placement.notebook_id
  AND heights.placement_id = placement.placement_id;

CREATE INDEX knowledge_placement_child_height
  ON content.knowledge_placement(route, notebook_id, parent_id, subtree_height DESC, placement_id);
CREATE INDEX knowledge_revision_history
  ON content.knowledge_revision(route, document_id, created_at DESC, revision_id DESC);

CREATE TABLE content.knowledge_structure_page (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  notebook_id uuid NOT NULL,
  page_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  document_id uuid NOT NULL,
  parent_id uuid,
  position numeric(38, 0) NOT NULL CHECK (position >= 0),
  tree_height smallint NOT NULL CHECK (tree_height BETWEEN 1 AND 63),
  left_page_id uuid,
  right_page_id uuid,
  PRIMARY KEY (route, notebook_id, page_id),
  FOREIGN KEY (route, notebook_id, placement_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id),
  FOREIGN KEY (route, notebook_id, document_id)
    REFERENCES content.knowledge_document(route, notebook_id, document_id),
  FOREIGN KEY (route, notebook_id, parent_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id),
  FOREIGN KEY (route, notebook_id, left_page_id)
    REFERENCES content.knowledge_structure_page(route, notebook_id, page_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (route, notebook_id, right_page_id)
    REFERENCES content.knowledge_structure_page(route, notebook_id, page_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (route = get_byte(uuid_send(page_id), 10) * 256 + get_byte(uuid_send(page_id), 11)),
  CHECK (route = get_byte(uuid_send(placement_id), 10) * 256 + get_byte(uuid_send(placement_id), 11)),
  CHECK (route = get_byte(uuid_send(document_id), 10) * 256 + get_byte(uuid_send(document_id), 11))
);

CREATE TABLE content.knowledge_structure_parent_root (
  route integer NOT NULL,
  notebook_id uuid NOT NULL,
  parent_id uuid,
  revision_number bigint NOT NULL,
  root_page_id uuid,
  UNIQUE NULLS NOT DISTINCT (route, notebook_id, parent_id, revision_number),
  FOREIGN KEY (route, notebook_id, parent_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id),
  FOREIGN KEY (route, notebook_id, revision_number)
    REFERENCES content.knowledge_structure_revision(route, notebook_id, revision_number),
  FOREIGN KEY (route, notebook_id, root_page_id)
    REFERENCES content.knowledge_structure_page(route, notebook_id, page_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX knowledge_structure_parent_root_at
  ON content.knowledge_structure_parent_root(route, notebook_id, parent_id, revision_number DESC);

CREATE TABLE content.knowledge_structure_change (
  route integer NOT NULL,
  notebook_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  placement_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('placement_added', 'placement_moved', 'placement_reordered', 'order_rebalanced')),
  previous_parent_id uuid,
  previous_position numeric(38, 0),
  parent_id uuid,
  position numeric(38, 0) NOT NULL CHECK (position >= 0),
  PRIMARY KEY (route, notebook_id, revision_number, placement_id),
  FOREIGN KEY (route, notebook_id, revision_number)
    REFERENCES content.knowledge_structure_revision(route, notebook_id, revision_number),
  FOREIGN KEY (route, notebook_id, placement_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id),
  FOREIGN KEY (route, notebook_id, previous_parent_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id),
  FOREIGN KEY (route, notebook_id, parent_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id),
  CHECK ((action = 'placement_added') = (previous_position IS NULL)),
  CHECK (route = get_byte(uuid_send(placement_id), 10) * 256 + get_byte(uuid_send(placement_id), 11))
);
CREATE INDEX knowledge_structure_change_history
  ON content.knowledge_structure_change(route, notebook_id, revision_number DESC, placement_id);

-- Existing revisions predate retained structure state. The current head is the migration baseline; earlier
-- structure IDs remain visible in history but cannot be selected as exact outlines.
WITH RECURSIVE sibling_groups AS (
  SELECT route, notebook_id, parent_id, count(*)::bigint AS item_count
  FROM content.knowledge_placement
  GROUP BY route, notebook_id, parent_id
), ranges(route, notebook_id, parent_id, first_rank, last_rank) AS (
  SELECT route, notebook_id, parent_id, 1::bigint, item_count
  FROM sibling_groups
  WHERE item_count > 0
  UNION ALL
  SELECT ranges.route, ranges.notebook_id, ranges.parent_id, children.first_rank, children.last_rank
  FROM ranges
  CROSS JOIN LATERAL (SELECT (ranges.first_rank + ranges.last_rank) / 2 AS middle_rank) middle
  CROSS JOIN LATERAL (
    VALUES (ranges.first_rank, middle.middle_rank - 1), (middle.middle_rank + 1, ranges.last_rank)
  ) children(first_rank, last_rank)
  WHERE children.first_rank <= children.last_rank
), ranked AS (
  SELECT placement.route,
         placement.notebook_id,
         placement.parent_id,
         placement.placement_id,
         placement.document_id,
         placement.position,
         row_number() OVER (
           PARTITION BY placement.route, placement.notebook_id, placement.parent_id
           ORDER BY placement.position, placement.placement_id
         ) AS item_rank
  FROM content.knowledge_placement placement
), page_nodes AS (
  SELECT item.route,
         item.notebook_id,
         item.placement_id AS page_id,
         item.placement_id,
         item.document_id,
         item.parent_id,
         item.position,
         ceil(log(2::numeric, (ranges.last_rank - ranges.first_rank + 2)::numeric))::smallint AS tree_height,
         left_item.placement_id AS left_page_id,
         right_item.placement_id AS right_page_id
  FROM ranges
  CROSS JOIN LATERAL (SELECT (ranges.first_rank + ranges.last_rank) / 2 AS middle_rank) middle
  JOIN ranked item
    ON item.route = ranges.route
   AND item.notebook_id = ranges.notebook_id
   AND item.parent_id IS NOT DISTINCT FROM ranges.parent_id
   AND item.item_rank = middle.middle_rank
  LEFT JOIN ranked left_item
    ON left_item.route = ranges.route
   AND left_item.notebook_id = ranges.notebook_id
   AND left_item.parent_id IS NOT DISTINCT FROM ranges.parent_id
   AND left_item.item_rank = (ranges.first_rank + middle.middle_rank - 1) / 2
   AND ranges.first_rank < middle.middle_rank
  LEFT JOIN ranked right_item
    ON right_item.route = ranges.route
   AND right_item.notebook_id = ranges.notebook_id
   AND right_item.parent_id IS NOT DISTINCT FROM ranges.parent_id
   AND right_item.item_rank = (middle.middle_rank + 1 + ranges.last_rank) / 2
   AND middle.middle_rank < ranges.last_rank
)
INSERT INTO content.knowledge_structure_page
  (route, notebook_id, page_id, placement_id, document_id, parent_id, position, tree_height, left_page_id, right_page_id)
SELECT route, notebook_id, page_id, placement_id, document_id, parent_id, position, tree_height, left_page_id, right_page_id
FROM page_nodes;

WITH notebook_heads AS (
  SELECT notebook.route,
         notebook.notebook_id,
         notebook.structure_revision_id,
         notebook.structure_revision_number
  FROM content.knowledge_notebook notebook
), parents AS (
  SELECT route, notebook_id, NULL::uuid AS parent_id FROM content.knowledge_notebook
  UNION ALL
  SELECT route, notebook_id, placement_id AS parent_id FROM content.knowledge_placement
), ranked AS (
  SELECT route,
         notebook_id,
         parent_id,
         placement_id,
         row_number() OVER (
           PARTITION BY route, notebook_id, parent_id
           ORDER BY position, placement_id
         ) AS item_rank,
         count(*) OVER (PARTITION BY route, notebook_id, parent_id) AS item_count
  FROM content.knowledge_placement
), roots AS (
  SELECT route, notebook_id, parent_id, placement_id AS root_page_id
  FROM ranked
  WHERE item_rank = (item_count + 1) / 2
)
INSERT INTO content.knowledge_structure_parent_root
  (route, notebook_id, parent_id, revision_number, root_page_id)
SELECT parents.route,
       parents.notebook_id,
       parents.parent_id,
       heads.structure_revision_number,
       roots.root_page_id
FROM parents
JOIN notebook_heads heads USING (route, notebook_id)
LEFT JOIN roots
  ON roots.route = parents.route
 AND roots.notebook_id = parents.notebook_id
 AND roots.parent_id IS NOT DISTINCT FROM parents.parent_id;

CREATE FUNCTION content.guard_knowledge_structure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Knowledge structure revisions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER knowledge_structure_page_immutable
  BEFORE UPDATE OR DELETE ON content.knowledge_structure_page
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_structure();
CREATE TRIGGER knowledge_structure_root_immutable
  BEFORE UPDATE OR DELETE ON content.knowledge_structure_parent_root
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_structure();
CREATE TRIGGER knowledge_structure_change_immutable
  BEFORE UPDATE OR DELETE ON content.knowledge_structure_change
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_structure();

-- migrate:down
DROP TRIGGER knowledge_structure_change_immutable ON content.knowledge_structure_change;
DROP TRIGGER knowledge_structure_root_immutable ON content.knowledge_structure_parent_root;
DROP TRIGGER knowledge_structure_page_immutable ON content.knowledge_structure_page;
DROP FUNCTION content.guard_knowledge_structure();
DROP TABLE content.knowledge_structure_change;
DROP TABLE content.knowledge_structure_parent_root;
DROP TABLE content.knowledge_structure_page;
DROP INDEX content.knowledge_revision_history;
DROP INDEX content.knowledge_placement_child_height;
ALTER TABLE content.knowledge_placement
  DROP CONSTRAINT knowledge_placement_route_notebook_id_parent_id_position_key;
WITH ranked AS (
  SELECT route,
         notebook_id,
         placement_id,
         row_number() OVER (
           PARTITION BY route, notebook_id, parent_id
           ORDER BY position, placement_id
         ) - 1 AS position
  FROM content.knowledge_placement
)
UPDATE content.knowledge_placement placement
SET position = ranked.position
FROM ranked
WHERE ranked.route = placement.route
  AND ranked.notebook_id = placement.notebook_id
  AND ranked.placement_id = placement.placement_id;
ALTER TABLE content.knowledge_placement
  ALTER COLUMN position TYPE bigint USING position::bigint,
  DROP COLUMN subtree_height;
ALTER TABLE content.knowledge_placement
  ADD CONSTRAINT knowledge_placement_route_notebook_id_parent_id_position_key
    UNIQUE NULLS NOT DISTINCT (route, notebook_id, parent_id, position);
ALTER TABLE content.knowledge_structure_revision
  DROP CONSTRAINT knowledge_structure_revision_number_key,
  DROP COLUMN revision_number,
  DROP COLUMN history_complete,
  DROP COLUMN change_kind;
ALTER TABLE content.knowledge_notebook DROP COLUMN structure_revision_number;
