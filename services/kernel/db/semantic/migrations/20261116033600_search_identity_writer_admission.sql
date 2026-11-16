-- migrate:up
CREATE UNIQUE INDEX identity_epoch_step_search_writer_admission ON semantic.identity_epoch_step
  (partition_no,job_id,job_epoch,((frontier->'after'->>1)))
  WHERE step='search-canonical-index' AND state='more' AND frontier->'after'->>0='search-writer-admitted';

-- migrate:down
DROP INDEX semantic.identity_epoch_step_search_writer_admission;
