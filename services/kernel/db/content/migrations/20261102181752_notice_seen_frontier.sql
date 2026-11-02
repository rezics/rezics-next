-- migrate:up
-- Retain the immutable inbox position independently of notice retention.
-- ALTER holds the table lock through backfill, so marks cannot race migration.
ALTER TABLE content.notice_seen ADD COLUMN seen_created_at timestamptz;

UPDATE content.notice_seen AS frontier
SET seen_created_at = notice.created_at
FROM content.notice AS notice
WHERE notice.route = frontier.route
  AND notice.notice_id = frontier.seen_notice_id
  AND notice.recipient_id = frontier.account_id;

-- An absent legacy point has no recoverable creation time. Reset to all unread
-- rather than inventing a position from UUID time or searching recipient history.
DELETE FROM content.notice_seen WHERE seen_created_at IS NULL;
ALTER TABLE content.notice_seen ALTER COLUMN seen_created_at SET NOT NULL;

-- migrate:down
-- Older binaries can use surviving IDs but lose retention-independent ordering.
ALTER TABLE content.notice_seen DROP COLUMN seen_created_at;
