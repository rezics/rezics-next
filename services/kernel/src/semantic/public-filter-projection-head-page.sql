SELECT partition_no, owner_epoch, position::text
FROM semantic.public_filter_projection_head
WHERE build_id = :build_id::uuid AND partition_no > :after_partition::integer
ORDER BY partition_no
LIMIT :input_limit::integer;
