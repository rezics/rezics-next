WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :subject_ids::uuid[] AS subject_ids
)
SELECT s.subject_id::text AS id,
       COALESCE(jsonb_object_agg(f.language, f.body) FILTER (WHERE f.kind = 'label' AND f.operation = 'assert'), '{}'::jsonb) AS labels
FROM semantic.subject AS s
CROSS JOIN input
LEFT JOIN semantic.fact AS f ON f.route = s.route AND f.subject_id = s.subject_id
  AND f.kind = 'label' AND f.operation = 'assert'
  AND f.route >= input.partition_no * 16
  AND f.route < (input.partition_no + 1) * 16
WHERE s.route >= input.partition_no * 16
  AND s.route < (input.partition_no + 1) * 16
  AND s.subject_id = ANY(input.subject_ids)
GROUP BY s.subject_id;
