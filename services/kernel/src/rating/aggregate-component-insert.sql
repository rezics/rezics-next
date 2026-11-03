WITH incoming AS (
  SELECT :route::integer AS route, :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :target_id::uuid AS target_id, :shard::smallint AS shard, :count_delta::bigint AS count_delta,
         :sum_delta::bigint AS sum_delta, :histogram_delta::bigint[] AS histogram_delta,
         :at::timestamptz AS at
)
INSERT INTO rating.aggregate_component
  (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
SELECT incoming.route, incoming.question_id, incoming.population_id, incoming.target_id, incoming.shard,
       incoming.count_delta, incoming.sum_delta, incoming.histogram_delta, incoming.at
FROM incoming
WHERE cardinality(incoming.histogram_delta) BETWEEN 1 AND 4097
  AND array_ndims(incoming.histogram_delta) = 1
  AND array_lower(incoming.histogram_delta, 1) = 1
  AND array_upper(incoming.histogram_delta, 1) = cardinality(incoming.histogram_delta)
  AND incoming.count_delta::numeric BETWEEN 0 AND 9223372036854775807
  AND incoming.sum_delta::numeric BETWEEN 0 AND 9223372036854775807
  AND 0::bigint <= ALL(incoming.histogram_delta)
ON CONFLICT (route, question_id, population_id, target_id, shard) DO NOTHING
RETURNING 1;
