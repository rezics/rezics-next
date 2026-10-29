-- migrate:up
-- A retained source export carries the previous route until withdrawal has native custody.
ALTER TABLE semantic.identity_epoch_bootstrap_row ADD COLUMN previous_partition integer;
ALTER TABLE semantic.identity_epoch_bootstrap_row ADD COLUMN previous_terminal uuid;
ALTER TABLE semantic.identity_epoch_bootstrap_custody ADD COLUMN stage text NOT NULL DEFAULT 'add'
  CHECK(stage IN ('withdraw','add'));
ALTER TABLE semantic.identity_epoch_bootstrap_custody DROP CONSTRAINT identity_epoch_bootstrap_custody_pkey;
ALTER TABLE semantic.identity_epoch_bootstrap_custody ADD PRIMARY KEY(partition_no,source_partition,source_generation,stage);

-- migrate:down
-- Forward-only retained custody.
