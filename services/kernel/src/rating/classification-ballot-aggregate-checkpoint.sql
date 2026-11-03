SELECT epoch, position::text AS position
FROM core.consumer_checkpoint
WHERE partition_no = :partition::integer AND consumer = 'rating_classification_ballot';
