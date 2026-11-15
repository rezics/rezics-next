-- migrate:up
CREATE INDEX native_source_capture_output_generation ON library.native_source_capture
  (route,collection_id,output_generation) WHERE scope='active_explicit_output';
CREATE INDEX identity_scope_plan_output_generation ON library.identity_scope_plan
  (route,collection_id,(source_identity->>'outputGeneration'))
  WHERE source_identity->>'scope'='active_explicit_output';

-- migrate:down
DROP INDEX library.identity_scope_plan_output_generation;
DROP INDEX library.native_source_capture_output_generation;
