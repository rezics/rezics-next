SELECT q.minimum_units AS "minimumUnits", q.maximum_units AS "maximumUnits", q.step_units AS "stepUnits",
       c.count::text AS count, c.sum::text AS sum, array_to_json(c.histogram)::text AS histogram,
       c.applied_at::text AS "appliedAt"
FROM rating.question AS q
LEFT JOIN rating.aggregate_component AS c
  ON c.route = :route::integer AND c.question_id = q.id AND c.population_id = :population_id::uuid
 AND c.target_id = :target_id::uuid
WHERE q.id = :question_id::uuid
ORDER BY c.shard;
