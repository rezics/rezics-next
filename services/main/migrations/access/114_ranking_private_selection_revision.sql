-- Context personal selections are Access UUID revisions; Realm selections are
-- graph IRIs. Keep the original IRI form for existing ranking generations.
ALTER TABLE access.ranking_generation
  DROP CONSTRAINT ranking_generation_semantic_selection_revision_check;
ALTER TABLE access.ranking_generation
  ADD CONSTRAINT ranking_generation_semantic_selection_revision_check
  CHECK (semantic_selection_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'
    OR semantic_selection_revision ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
