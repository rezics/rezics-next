-- migrate:up
CREATE INDEX aggregate_component_target_population_idx
  ON rating.aggregate_component (route, question_id, target_id, population_id, shard)
  WHERE count > 0;

-- migrate:down
-- Forward only: existing aggregate pages depend on this target-first lookup.
