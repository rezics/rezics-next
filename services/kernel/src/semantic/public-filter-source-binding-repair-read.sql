SELECT step::text, state, complete
FROM semantic.public_filter_repair_step
WHERE partition_no = 0 AND bootstrap = :bootstrap::uuid AND execution = :execution::text
  AND predecessor IS NOT DISTINCT FROM NULLIF(:predecessor::text, '')::uuid
LIMIT 1;
