-- migrate:up
-- New native locators are <=512 bytes. Keep the exact key below PostgreSQL's index tuple bound.
-- Older oversized locators remain retained; this index does not grant disposition authority.
CREATE INDEX collection_kind_retired_capture ON library.collection_kind_retired
  (route, collection_id, account_id, capture) WHERE octet_length(capture)<=512;

-- migrate:down
DROP INDEX library.collection_kind_retired_capture;
