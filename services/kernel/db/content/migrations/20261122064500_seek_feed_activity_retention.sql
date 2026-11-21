-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY feed_activity_retention_due ON content.feed_activity(occurred_at,partition_no);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY content.feed_activity_retention_due;
