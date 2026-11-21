-- migrate:up
ALTER TABLE semantic.erasure_shared_custody
  DROP CONSTRAINT erasure_shared_custody_pkey,
  ADD CONSTRAINT erasure_shared_custody_origin UNIQUE NULLS NOT DISTINCT
    (partition_no, account_id, role, transaction_id, outbox_position);

-- migrate:down
ALTER TABLE semantic.erasure_shared_custody
  DROP CONSTRAINT erasure_shared_custody_origin,
  ADD CONSTRAINT erasure_shared_custody_pkey PRIMARY KEY (partition_no, account_id, role, transaction_id);
