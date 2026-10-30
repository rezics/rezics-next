-- migrate:up
-- Retention probes keep native source custody intact without walking capture history.
CREATE INDEX native_source_capture_collection ON library.native_source_capture
  (route, collection_id, capture_id);
CREATE INDEX native_source_capture_account ON library.native_source_capture
  (route, account_id, capture_id);

-- migrate:down
-- Forward only: preserve bounded custody discovery.
