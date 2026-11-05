-- migrate:up
ALTER TABLE library.collection_archive_recovery ADD COLUMN create_failure text
  CHECK (create_failure IS NULL OR create_failure = 'unsupported_or_stale');

-- migrate:down
ALTER TABLE library.collection_archive_recovery DROP COLUMN create_failure;
