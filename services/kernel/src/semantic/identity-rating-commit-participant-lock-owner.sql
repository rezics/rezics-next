SELECT partition_no, node::text AS "ownerId", epoch, write_state AS "writeState"
FROM core.partition
WHERE partition_no = :partition_no
FOR UPDATE;
