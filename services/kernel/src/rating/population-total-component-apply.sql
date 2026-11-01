-- Missing shards were explicitly materialized as zero in this destination command.
-- UPDATE takes the conflicting tuple lock; signed deltas are never clamped.
WITH input AS (
  SELECT :count_delta::bigint AS count_delta, :sum_delta::bigint AS sum_delta,
         :check_epoch::boolean AS check_epoch
)
UPDATE rating.population_total_component AS total
SET count = total.count + input.count_delta,
    sum = total.sum + input.sum_delta,
    needs_epoch_check = total.needs_epoch_check OR (input.check_epoch AND input.count_delta <> 0)
FROM input
WHERE total.route = :population_route::integer AND total.question_id = :question_id::uuid
  AND total.population_id = :population_id::uuid AND total.shard = :shard::smallint
RETURNING 1;
