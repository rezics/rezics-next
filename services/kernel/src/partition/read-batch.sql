SELECT partition_no AS "partitionNo", node, write_state AS "writeState", moved_to AS "movedTo", epoch, position
FROM core.partition
WHERE partition_no = ANY(:partitions::integer[]);
