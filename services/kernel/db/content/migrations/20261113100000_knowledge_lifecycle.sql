-- migrate:up
-- Lifecycle lives with the stable native document, never in a second trash population.
ALTER TABLE content.knowledge_document
  ADD COLUMN lifecycle_generation bigint NOT NULL DEFAULT 0 CHECK (lifecycle_generation >= 0),
  ADD COLUMN deleted_at timestamptz CHECK (deleted_at IS NULL OR isfinite(deleted_at)),
  ADD COLUMN purge_started_at timestamptz CHECK (purge_started_at IS NULL OR isfinite(purge_started_at)),
  ADD COLUMN purge_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE content.knowledge_publication
  ADD COLUMN lifecycle_generation bigint NOT NULL DEFAULT 0 CHECK (lifecycle_generation >= 0);

-- One point per primary ancestor, including the document itself. Missing parents, cycles and an
-- overlong chain cannot produce an eligible root. Only lifecycle commands may admit a trashed target;
-- they still require every parent to be live. No references or siblings are visited.
CREATE FUNCTION content.knowledge_document_eligible(
  selected_route integer, selected_document uuid, include_trashed_target boolean DEFAULT false
) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE path AS (
    SELECT p.notebook_id, p.placement_id, p.parent_id, 0 AS depth,
           (d.deleted_at IS NULL OR include_trashed_target)
             AND d.purge_started_at IS NULL AND NOT d.purge_completed AS eligible
    FROM content.knowledge_document d
    JOIN content.knowledge_placement p
      ON p.route=d.route AND p.notebook_id=d.notebook_id AND p.document_id=d.document_id
    WHERE d.route=selected_route AND d.document_id=selected_document
    UNION ALL
    SELECT p.notebook_id, p.placement_id, p.parent_id, child.depth+1,
           d.deleted_at IS NULL AND d.purge_started_at IS NULL AND NOT d.purge_completed
    FROM path child
    JOIN content.knowledge_placement p
      ON p.route=selected_route AND p.notebook_id=child.notebook_id AND p.placement_id=child.parent_id
    JOIN content.knowledge_document d
      ON d.route=p.route AND d.notebook_id=p.notebook_id AND d.document_id=p.document_id
    WHERE child.depth<31
  )
  SELECT COALESCE(bool_and(eligible) AND bool_or(parent_id IS NULL), false) FROM path;
$$;

-- migrate:down
DROP FUNCTION content.knowledge_document_eligible(integer,uuid,boolean);
ALTER TABLE content.knowledge_publication DROP COLUMN lifecycle_generation;
ALTER TABLE content.knowledge_document
  DROP COLUMN lifecycle_generation, DROP COLUMN deleted_at, DROP COLUMN purge_started_at,
  DROP COLUMN purge_completed, DROP COLUMN legal_hold;
