-- migrate:up
-- Immutable derived local IDs let reference disclosure check an exact block without fetching target bodies.
CREATE FUNCTION content.knowledge_block_ids(bytes bytea) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH RECURSIVE nodes(value) AS (
    SELECT convert_from(bytes, 'UTF8')::jsonb -> 'doc'
    UNION ALL
    SELECT child.value
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(nodes.value -> 'content', '[]'::jsonb)) child(value)
  )
  SELECT COALESCE(array_agg(value -> 'attrs' ->> 'id')
    FILTER (WHERE value -> 'attrs' ->> 'id' IS NOT NULL), '{}'::text[])
  FROM nodes;
$$;

ALTER TABLE content.knowledge_revision
  ADD COLUMN reference_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN copy_provenance jsonb,
  ADD COLUMN block_ids text[] GENERATED ALWAYS AS (content.knowledge_block_ids(canonical_bytes)) STORED;

-- migrate:down
ALTER TABLE content.knowledge_revision
  DROP COLUMN block_ids,
  DROP COLUMN copy_provenance,
  DROP COLUMN reference_manifest;
DROP FUNCTION content.knowledge_block_ids(bytea);
