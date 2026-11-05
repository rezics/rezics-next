WITH incoming AS (
  SELECT :route::integer AS route, :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :target_id::uuid AS target_id, :shard::smallint AS shard, :count_delta::bigint AS count_delta,
         :sum_delta::bigint AS sum_delta, :histogram_delta::bigint[] AS histogram_delta,
         :at::timestamptz AS at
)
UPDATE rating.aggregate_component AS component
SET count = (component.count::numeric + incoming.count_delta::numeric)::bigint,
    sum = (component.sum::numeric + incoming.sum_delta::numeric)::bigint,
    histogram = ARRAY(
      SELECT (component.histogram[index]::numeric + incoming.histogram_delta[index]::numeric)::bigint
      FROM generate_subscripts(component.histogram, 1) AS bins(index)
      ORDER BY index
    ),
    applied_at = GREATEST(component.applied_at, incoming.at)
FROM incoming
WHERE component.route = incoming.route AND component.question_id = incoming.question_id
  AND component.population_id = incoming.population_id AND component.target_id = incoming.target_id
  AND component.shard = incoming.shard
  AND cardinality(incoming.histogram_delta) BETWEEN 1 AND 4097
  AND array_ndims(incoming.histogram_delta) = 1
  AND array_lower(incoming.histogram_delta, 1) = 1
  AND array_upper(incoming.histogram_delta, 1) = cardinality(incoming.histogram_delta)
  AND cardinality(component.histogram) = cardinality(incoming.histogram_delta)
  AND array_lower(component.histogram, 1) = 1
  AND array_upper(component.histogram, 1) = cardinality(component.histogram)
  AND component.count::numeric + incoming.count_delta::numeric BETWEEN 0 AND 9223372036854775807
  AND component.sum::numeric + incoming.sum_delta::numeric BETWEEN 0 AND 9223372036854775807
  AND NOT EXISTS (
    SELECT 1
    FROM generate_subscripts(component.histogram, 1) AS bins(index)
    WHERE component.histogram[index]::numeric + incoming.histogram_delta[index]::numeric
      NOT BETWEEN 0 AND 9223372036854775807
  )
RETURNING 1;
