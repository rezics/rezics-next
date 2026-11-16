-- migrate:up
CREATE INDEX identity_epoch_step_search_directory ON semantic.identity_epoch_step
  (partition_no,job_id,job_epoch,native_position,transaction_id)
  WHERE step='search-canonical-index' AND state='more' AND frontier->'after'->>0='search-directory';

-- migrate:down
DROP INDEX semantic.identity_epoch_step_search_directory;
