SELECT write_state, moved_to
FROM core.partition
WHERE partition_no = :partition_no::integer
FOR SHARE;
