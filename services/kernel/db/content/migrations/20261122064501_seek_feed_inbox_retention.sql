-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY feed_inbox_retention_due ON content.feed_inbox(occurred_at,partition_no);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY content.feed_inbox_retention_due;
