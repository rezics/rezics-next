-- migrate:up
CREATE INDEX consumer_checkpoint_consumer_idx
  ON core.consumer_checkpoint (consumer, partition_no);

-- migrate:down
DROP INDEX core.consumer_checkpoint_consumer_idx;
