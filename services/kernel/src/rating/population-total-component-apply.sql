-- Missing shards were explicitly materialized as zero in this destination command.
-- UPDATE takes the conflicting tuple lock; signed deltas are never clamped.
UPDATE rating.population_total_component
SET count = count + :count_delta::bigint,
    sum = sum + :sum_delta::bigint,
    needs_epoch_check = needs_epoch_check OR (:check_epoch::boolean AND :count_delta::bigint <> 0)
WHERE route = :population_route::integer AND question_id = :question_id::uuid
  AND population_id = :population_id::uuid AND shard = :shard::smallint
RETURNING 1;
