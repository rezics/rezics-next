-- migrate:up
CREATE INDEX identity_epoch_step_search_writer_support ON semantic.identity_epoch_step
  (partition_no,job_id,job_epoch,((frontier->'after'->>1)),((frontier->'after'->>2)),native_position,transaction_id)
  WHERE step='search-canonical-index' AND state='more' AND frontier->'after'->>0='search-writer-support';

-- migrate:down
DROP INDEX semantic.identity_epoch_step_search_writer_support;
