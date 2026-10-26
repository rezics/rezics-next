WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id, s.type
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, id)
JOIN LATERAL (
  SELECT subject_id, type FROM semantic.subject
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id AND visibility = 'visible'
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  LIMIT 1
) AS s ON true;
