SELECT frontier::text, observation, binding, capture, state,
  CASE WHEN jsonb_array_length(subjects) <= $3 THEN subjects ELSE '[]'::jsonb END AS subjects,
  jsonb_array_length(subjects) AS replay_keys, complete, expires::text
FROM semantic.facet_population_frontier WHERE partition_no = $1 AND predecessor = $2::uuid;
