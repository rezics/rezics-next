SELECT epoch, position
FROM core.partition
WHERE partition_no = :partition_no AND write_state = 'active'
FOR SHARE;
