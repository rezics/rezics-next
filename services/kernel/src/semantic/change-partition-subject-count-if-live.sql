UPDATE semantic.partition_subjects counts
SET visible = counts.visible + :delta::bigint
WHERE counts.partition_no = :partition_no::integer
  AND NOT EXISTS (
    SELECT 1 FROM semantic.redirect
    WHERE route = :route::integer AND subject_id = :subject_id::uuid
  );
