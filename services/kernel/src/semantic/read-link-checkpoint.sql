SELECT epoch, position
FROM core.consumer_checkpoint
WHERE partition_no = :partition_no::integer AND consumer = :consumer::text
LIMIT 1;
