WITH population_input AS (
  SELECT :population_route::integer AS route, :population_id::uuid AS population_id
)
SELECT q.minimum_units AS "minimumUnits", q.maximum_units AS "maximumUnits", q.step_units AS "stepUnits",
       EXISTS (
         SELECT 1 FROM rating.population_pending AS pending
         WHERE pending.route = population_input.route AND pending.population_id = population_input.population_id
           AND pending.pending_jobs > 0
       ) AS updating,
       c.count::text AS count, c.sum::text AS sum, array_to_json(c.histogram)::text AS histogram,
       c.applied_at::text AS "appliedAt"
FROM rating.question AS q
CROSS JOIN population_input
LEFT JOIN rating.aggregate_component AS c
  ON c.route = :route::integer AND c.question_id = q.id AND c.population_id = population_input.population_id
 AND c.target_id = :target_id::uuid
WHERE q.id = :question_id::uuid
ORDER BY c.shard;
