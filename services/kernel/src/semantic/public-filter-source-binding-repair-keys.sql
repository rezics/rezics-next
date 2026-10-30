SELECT s.route, s.subject_id::text
FROM semantic.subject s
WHERE s.route >= :partition_no::integer * 16 AND s.route < (:partition_no::integer + 1) * 16
  AND (s.route,s.subject_id) > (:after_route::integer,:after_id::uuid)
ORDER BY s.route,s.subject_id LIMIT 1;
