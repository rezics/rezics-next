-- unbound: one Global partition primary-key probe, closed state and length only.
SELECT write_state AS "writeState", octet_length(moved_to) AS "movedToBytes"
FROM core.partition
WHERE partition_no = :partition_no;
