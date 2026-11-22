-- migrate:up transaction:false
CREATE UNIQUE INDEX CONCURRENTLY erasure_source_record_cursor_primary ON semantic.erasure_source_record
  (partition_no,account_id,store,record_key,role,delivery_position,origin_key);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY semantic.erasure_source_record_cursor_primary;
