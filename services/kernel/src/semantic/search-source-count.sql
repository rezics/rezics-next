SELECT visible::text AS visible
FROM semantic.partition_subjects
WHERE partition_no = :partition_no::integer;
