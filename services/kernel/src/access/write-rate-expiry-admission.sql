SELECT node, write_state AS "writeState"
FROM core.partition
WHERE partition_no = :partition_no::integer
FOR SHARE;
