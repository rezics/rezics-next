WITH incoming AS (
  SELECT :route::integer AS route, :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :target_id::uuid AS target_id, :shard::smallint AS shard, :count_delta::bigint AS count_delta,
         :sum_delta::bigint AS sum_delta, :histogram_delta::bigint[] AS histogram_delta,
         :at::timestamptz AS at
), component_before AS (
  SELECT component.count, component.sum, component.histogram, component.applied_at
  FROM rating.aggregate_component AS component CROSS JOIN incoming
  WHERE component.route = incoming.route AND component.question_id = incoming.question_id
    AND component.population_id = incoming.population_id AND component.target_id = incoming.target_id
    AND component.shard = incoming.shard
)
INSERT INTO rating.aggregate_component
  (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
SELECT incoming.route, incoming.question_id, incoming.population_id, incoming.target_id, incoming.shard,
       COALESCE(component_before.count, 0) + incoming.count_delta,
       COALESCE(component_before.sum, 0) + incoming.sum_delta,
       ARRAY(
         SELECT COALESCE(component_before.histogram[index], 0) + incoming.histogram_delta[index]
         FROM generate_subscripts(incoming.histogram_delta, 1) AS bins(index)
         ORDER BY index
       ),
       GREATEST(COALESCE(component_before.applied_at, '-infinity'::timestamptz), incoming.at)
FROM incoming LEFT JOIN component_before ON true
WHERE component_before.histogram IS NULL
   OR cardinality(component_before.histogram) = cardinality(incoming.histogram_delta)
ON CONFLICT (route, question_id, population_id, target_id, shard) DO UPDATE
SET count = EXCLUDED.count,
    sum = EXCLUDED.sum,
    histogram = EXCLUDED.histogram,
    applied_at = EXCLUDED.applied_at
RETURNING 1;
