-- migrate:up
CREATE INDEX notice_retention_due ON content.notice (created_at, route);
CREATE INDEX notice_finalization_retention_due ON content.notice_finalization (created_at, route);
CREATE INDEX thread_watch_notice_retention_due ON content.thread_watch_notice_work (published_at, route);
CREATE INDEX board_watch_notice_retention_due ON content.board_watch_notice_work (published_at, route);
CREATE INDEX post_purge_due ON content.post (deleted_at, route) WHERE deleted_at IS NOT NULL AND NOT purge_completed;
CREATE INDEX media_collection_due ON content.media (created_at, route) WHERE claimed_at IS NULL AND NOT erased AND NOT collection_pending;

-- migrate:down
DROP INDEX content.media_collection_due;
DROP INDEX content.post_purge_due;
DROP INDEX content.board_watch_notice_retention_due;
DROP INDEX content.thread_watch_notice_retention_due;
DROP INDEX content.notice_finalization_retention_due;
DROP INDEX content.notice_retention_due;
