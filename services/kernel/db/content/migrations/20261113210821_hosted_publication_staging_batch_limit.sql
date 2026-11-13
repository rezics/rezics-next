-- migrate:up
ALTER TABLE content.hosted_publication_staging_batch
  DROP CONSTRAINT hosted_publication_staging_batch_item_count_check;
ALTER TABLE content.hosted_publication_staging_batch
  ADD CONSTRAINT hosted_publication_staging_batch_item_count_check CHECK (item_count BETWEEN 1 AND 1024);

-- migrate:down
ALTER TABLE content.hosted_publication_staging_batch
  DROP CONSTRAINT hosted_publication_staging_batch_item_count_check;
ALTER TABLE content.hosted_publication_staging_batch
  ADD CONSTRAINT hosted_publication_staging_batch_item_count_check CHECK (item_count BETWEEN 1 AND 512);
