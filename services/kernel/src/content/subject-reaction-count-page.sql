WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition_no
)
SELECT requested.target_id AS "targetId",
       stored.kind,
       stored.count
FROM unnest(:target_ids::uuid[], :routes::integer[]) AS requested(target_id, route)
JOIN LATERAL (
  SELECT count_row.kind, count_row.count
  FROM content.reaction_total AS count_row
  CROSS JOIN input
  WHERE count_row.route = requested.route
    AND count_row.target_id = requested.target_id
    AND count_row.route >= input.partition_no * 16
    AND count_row.route < (input.partition_no + 1) * 16
    AND count_row.kind IN ('like', 'love', 'laugh', 'insightful', 'sad')
  ORDER BY count_row.kind
  LIMIT 5
) AS stored ON true;
