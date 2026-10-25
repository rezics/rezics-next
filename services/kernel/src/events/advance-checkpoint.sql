UPDATE core.consumer_checkpoint
SET epoch = :epoch, position = :position, updated_at = now()
WHERE partition_no = :partition_no AND consumer = :consumer;
