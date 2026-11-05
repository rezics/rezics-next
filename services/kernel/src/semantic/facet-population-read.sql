SELECT frontier::text, observation, binding, capture, state, '[]'::jsonb AS subjects, complete, expires::text
FROM semantic.facet_population_frontier WHERE partition_no = $1 AND frontier = $2::uuid;
