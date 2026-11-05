-- migrate:up
-- Equality-only tuple hydration does not need a second copy of wide metadata in an index.
-- Native source aliases cannot contain ':', so this key preserves the complete routed identity.
CREATE INDEX source_record_tuple_point ON semantic.source_record USING hash
  ((route::text || ':' || source || ':' || external_id));

-- The authority anchor only needs existence of the actual Global row, not its labels/settings.
CREATE INDEX context_global_point ON semantic.context (route, context_id) WHERE kind = 'global';

-- migrate:down
DROP INDEX semantic.context_global_point;
DROP INDEX semantic.source_record_tuple_point;
