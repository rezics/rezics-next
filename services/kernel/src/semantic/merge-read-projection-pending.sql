WITH input AS NOT MATERIALIZED (SELECT :partition_no::integer AS partition_no)
SELECT subject_id::text AS member_id
FROM semantic.subject CROSS JOIN input
WHERE route >= input.partition_no * 16
  AND route < (input.partition_no + 1) * 16
  AND subject_id = ANY(:members::uuid[])
  AND projection_pending;
