-- migrate:up
-- Same-authority access paths over canonical writes, including old data. No
-- maintained visibility, readiness or absence state is involved. The UUID value
-- domain also covers historical rows without a trustworthy relation flag; it
-- keeps unbounded descriptive text out of the btree key. Recording provenance
-- uses the existing complete revision_transaction key.
CREATE INDEX fact_scope_leaf_pair ON semantic.fact
  (route, subject_id, property, (body->'value'->>'content'), erasure_key)
  WHERE kind = 'statement' AND operation = 'assert' AND body->'value'->>'type' = 'value'
    AND body->'value'->>'content' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
CREATE INDEX candidate_scope_leaf_pair ON semantic.candidate
  (route, subject_id, property, (statement->'value'->>'content'), candidate_id)
  WHERE statement->'value'->>'type' = 'value'
    AND statement->'value'->>'content' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- migrate:down
DROP INDEX semantic.candidate_scope_leaf_pair;
DROP INDEX semantic.fact_scope_leaf_pair;
