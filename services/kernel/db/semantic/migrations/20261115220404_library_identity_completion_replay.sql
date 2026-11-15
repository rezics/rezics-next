-- migrate:up
CREATE INDEX identity_epoch_step_library_completion ON semantic.identity_epoch_step
  (partition_no,job_id,job_epoch,native_position,transaction_id)
  WHERE step='library-private-follow-counts' AND state='complete';

-- migrate:down
DROP INDEX semantic.identity_epoch_step_library_completion;
