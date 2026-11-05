WITH input AS (SELECT :partition_no::integer AS partition_no)
SELECT s.route, s.subject_id::text
FROM semantic.subject s CROSS JOIN input
WHERE s.route >= input.partition_no * 16 AND s.route < (input.partition_no + 1) * 16
  AND (s.route,s.subject_id) > (:after_route::integer,:after_id::uuid)
ORDER BY s.route,s.subject_id LIMIT 1;
