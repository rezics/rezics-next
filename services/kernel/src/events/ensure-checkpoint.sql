INSERT INTO core.consumer_checkpoint (partition_no, consumer)
VALUES (:partition_no, :consumer)
ON CONFLICT (partition_no, consumer) DO NOTHING;
