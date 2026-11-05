WITH input AS (
  SELECT :route::integer AS route, :question_id::uuid AS question_id, :population_id::uuid AS population_id
), locked AS MATERIALIZED (
  SELECT total.shard, total.count, total.sum
  FROM rating.population_total_component AS total CROSS JOIN input
  WHERE total.route = input.route AND total.question_id = input.question_id
    AND total.population_id = input.population_id
  ORDER BY total.shard
  FOR UPDATE
), totals AS (
  SELECT COALESCE(sum(locked.count), 0)::text AS count,
         COALESCE(sum(locked.sum), 0)::text AS sum,
         CASE WHEN COALESCE(sum(locked.count), 0) > 0
              THEN round(COALESCE(sum(locked.sum), 0)::numeric /
                         (2 * COALESCE(sum(locked.count), 0)::numeric), 4)::text
              ELSE NULL END AS mean
  FROM locked
), cleared AS (
  UPDATE rating.population_total_component AS total
  SET needs_epoch_check = false
  FROM input CROSS JOIN locked
  WHERE total.route = input.route AND total.question_id = input.question_id
    AND total.population_id = input.population_id AND total.shard = locked.shard
    AND total.needs_epoch_check
  RETURNING 1
)
SELECT totals.count, totals.sum, totals.mean, (SELECT count(*) FROM cleared)::text AS cleared
FROM totals;
