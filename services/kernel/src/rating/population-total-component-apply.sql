WITH incoming AS (
  SELECT :population_route::integer AS route, :question_id::uuid AS question_id,
         :population_id::uuid AS population_id, :shard::smallint AS shard,
         :count_delta::bigint AS count_delta, :sum_delta::bigint AS sum_delta,
         :check_epoch::boolean AS check_epoch
), component_before AS (
  SELECT total.count, total.sum, total.needs_epoch_check
  FROM rating.population_total_component AS total CROSS JOIN incoming
  WHERE total.route = incoming.route AND total.question_id = incoming.question_id
    AND total.population_id = incoming.population_id AND total.shard = incoming.shard
)
INSERT INTO rating.population_total_component
  (route, question_id, population_id, shard, count, sum, needs_epoch_check)
SELECT incoming.route, incoming.question_id, incoming.population_id, incoming.shard,
       COALESCE(component_before.count, 0) + incoming.count_delta,
       COALESCE(component_before.sum, 0) + incoming.sum_delta,
       COALESCE(component_before.needs_epoch_check, false) OR
         (incoming.check_epoch AND incoming.count_delta <> 0)
FROM incoming LEFT JOIN component_before ON true
WHERE (component_before.count IS NULL OR component_before.count + incoming.count_delta >= 0)
  AND (component_before.sum IS NULL OR component_before.sum + incoming.sum_delta >= 0)
ON CONFLICT (route, question_id, population_id, shard) DO UPDATE
SET count = EXCLUDED.count,
    sum = EXCLUDED.sum,
    needs_epoch_check = rating.population_total_component.needs_epoch_check OR EXCLUDED.needs_epoch_check
RETURNING 1;
