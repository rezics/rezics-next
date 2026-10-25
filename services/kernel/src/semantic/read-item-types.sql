WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :subject_ids::uuid[] AS subject_ids
)
SELECT s.subject_id::text AS id, s.type
FROM semantic.subject AS s
CROSS JOIN input
WHERE s.route >= input.partition_no * 16
  AND s.route < (input.partition_no + 1) * 16
  AND s.subject_id = ANY(input.subject_ids);
