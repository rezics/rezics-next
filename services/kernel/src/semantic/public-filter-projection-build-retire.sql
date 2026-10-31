DELETE FROM semantic.public_filter_projection_head
WHERE build_id = (
  SELECT build_id FROM semantic.public_filter_projection_build
  WHERE partition_no = :partition_no::integer AND subject_id = :subject_id::uuid
);
