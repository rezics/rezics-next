SELECT epoch, position::text AS position, write_state
FROM core.partition
WHERE partition_no = :partition_no::integer;
