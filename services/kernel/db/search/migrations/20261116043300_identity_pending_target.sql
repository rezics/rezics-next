-- migrate:up
CREATE INDEX identity_receiving_native_pending_target
  ON search.identity_receiving_native_pending (physical_target,partition_no,plan_id);

-- migrate:down
DROP INDEX search.identity_receiving_native_pending_target;
