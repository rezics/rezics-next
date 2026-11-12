-- migrate:up
-- Exact timestamp/UUID seeks bound both rows and examined keys on every page.
-- Include only the safe metadata returned by the author history reader.
CREATE INDEX hosted_structure_revision_history_idx
  ON content.hosted_structure_revision (route, catalogue_id, created_at DESC, revision_id DESC)
  INCLUDE (kind, source_revision_id);

-- migrate:down
DROP INDEX content.hosted_structure_revision_history_idx;
