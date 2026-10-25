SELECT epoch, position
FROM core.consumer_checkpoint
WHERE partition_no = :partition_no AND consumer = :consumer
FOR UPDATE SKIP LOCKED;
