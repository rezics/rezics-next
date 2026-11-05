SELECT epoch
FROM core.partition
WHERE partition_no = :partition_no::integer;
