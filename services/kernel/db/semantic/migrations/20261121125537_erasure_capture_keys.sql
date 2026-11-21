-- migrate:up
-- Each deferred capture writes both the current locator and its immutable origin.
-- The complete traversal keys also identify those rows uniquely.
ALTER TABLE semantic.erasure_locator
  DROP CONSTRAINT erasure_locator_pkey,
  ADD PRIMARY KEY (partition_no, store, record_key, account_id, role);
DROP INDEX semantic.erasure_locator_record;

ALTER TABLE semantic.erasure_source_record
  DROP CONSTRAINT erasure_source_record_pkey,
  ADD PRIMARY KEY (partition_no, account_id, store, record_key, role, delivery_position, origin_key);
DROP INDEX semantic.erasure_source_record_key;

-- migrate:down
ALTER TABLE semantic.erasure_locator
  DROP CONSTRAINT erasure_locator_pkey,
  ADD PRIMARY KEY (partition_no, account_id, role, store, record_key);
CREATE INDEX erasure_locator_record ON semantic.erasure_locator
  (partition_no, store, record_key, account_id, role);

ALTER TABLE semantic.erasure_source_record
  DROP CONSTRAINT erasure_source_record_pkey,
  ADD PRIMARY KEY (partition_no, account_id, role, store, record_key, delivery_position, origin_key);
CREATE INDEX erasure_source_record_key ON semantic.erasure_source_record
  (partition_no, account_id, store, record_key, role, delivery_position, origin_key);
