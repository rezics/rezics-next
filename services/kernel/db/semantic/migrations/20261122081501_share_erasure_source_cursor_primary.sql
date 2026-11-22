-- migrate:up
-- The complete durable cursor is also the identity of a Source occurrence.
ALTER TABLE semantic.erasure_source_record DROP CONSTRAINT erasure_source_record_pkey,
  ADD CONSTRAINT erasure_source_record_pkey PRIMARY KEY USING INDEX erasure_source_record_cursor_primary;
DROP INDEX semantic.erasure_source_record_key;

-- migrate:down
ALTER TABLE semantic.erasure_source_record DROP CONSTRAINT erasure_source_record_pkey,
  ADD CONSTRAINT erasure_source_record_pkey PRIMARY KEY
    (partition_no,account_id,role,store,record_key,delivery_position,origin_key);
CREATE INDEX erasure_source_record_key ON semantic.erasure_source_record
  (partition_no,account_id,store,record_key,role,delivery_position,origin_key);
CREATE UNIQUE INDEX erasure_source_record_cursor_primary ON semantic.erasure_source_record
  (partition_no,account_id,store,record_key,role,delivery_position,origin_key);
