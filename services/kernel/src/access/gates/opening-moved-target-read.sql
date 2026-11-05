-- unbound: one Global partition primary-key probe with its admitted text byte bound.
SELECT moved_to AS "movedTo"
FROM core.partition
WHERE partition_no = :partition_no AND write_state = 'moved'
  AND octet_length(moved_to) <= :bytes;
