SELECT position::text AS position
FROM core.partition
WHERE partition_no = :partition_no::integer;
