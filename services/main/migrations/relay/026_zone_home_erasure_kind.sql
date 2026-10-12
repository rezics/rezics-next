-- Home document publication cuts share the native graph revision tombstone.
ALTER TABLE relay.erasure_target DROP CONSTRAINT erasure_target_kind_owner;
ALTER TABLE relay.erasure_target ADD CONSTRAINT erasure_target_kind_owner
  CHECK ((target_kind, owner) IN (
    ('principal', 'access'),
    ('content_revision', 'content'),
    ('content_variant', 'content'),
    ('semantic_revision', 'graph'),
    ('resource', 'graph'),
    ('source_observation', 'source'),
    ('object', 'object'),
    ('text_contribution_draft', 'graph'),
    ('release_revision', 'graph'),
    ('work_head', 'graph'),
    ('composition_revision', 'graph'),
    ('home_document_revision', 'graph')));
