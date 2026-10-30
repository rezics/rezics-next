SELECT position::text, owner_epoch
FROM semantic.public_filter_repair_advance
WHERE partition_no = :partition_no::integer AND bootstrap = :bootstrap::uuid AND execution = :execution::text
  AND step = :step::uuid AND route = :route::integer AND subject_id = :subject_id::uuid;
