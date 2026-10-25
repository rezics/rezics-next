UPDATE semantic.partition_subjects
SET visible = visible + :delta::bigint
WHERE partition_no = :partition_no::integer;
