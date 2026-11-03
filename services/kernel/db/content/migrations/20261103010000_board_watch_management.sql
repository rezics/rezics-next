-- migrate:up
CREATE TABLE content.board_watch (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  watcher_account_id uuid NOT NULL,
  board_id uuid NOT NULL,
  watch_id uuid NOT NULL,
  watching boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, watcher_account_id, board_id),
  UNIQUE (route, watch_id),
  CHECK (route = get_byte(uuid_send(watcher_account_id), 10) * 256 + get_byte(uuid_send(watcher_account_id), 11)),
  CHECK (route = get_byte(uuid_send(watch_id), 10) * 256 + get_byte(uuid_send(watch_id), 11))
);
-- The same original row owns the account range and its inverse. Both indexes
-- change atomically; an asynchronous inverse cannot resurrect a removed edge.
CREATE INDEX board_watch_account_idx ON content.board_watch
  (route, watcher_account_id, created_at, watch_id) INCLUDE (board_id, revision) WHERE watching;
CREATE INDEX board_watch_fanout_idx ON content.board_watch
  (board_id, created_at, watch_id) INCLUDE (route, watcher_account_id) WHERE watching;
CREATE INDEX thread_watch_management_idx ON content.thread_watch
  (route, watcher_account_id, created_at, watch_id) INCLUDE (thread_id);

CREATE TABLE content.board_watch_notice_work (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  post_id uuid NOT NULL,
  board_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  source_id uuid NOT NULL,
  published_at timestamptz NOT NULL CHECK (isfinite(published_at)),
  cursor_created_at timestamptz,
  cursor_watch_id uuid,
  done boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, post_id),
  CHECK ((cursor_created_at IS NULL) = (cursor_watch_id IS NULL)),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11))
);
CREATE INDEX board_watch_notice_work_expire_idx ON content.board_watch_notice_work (route, published_at, post_id);

ALTER TABLE content.notice DROP CONSTRAINT notice_kind_check;
ALTER TABLE content.notice ADD CONSTRAINT notice_kind_check
  CHECK (kind IN ('reply', 'mention', 'thread_watch', 'board_activity', 'moderation_decision'));
ALTER TABLE content.notice_finalization DROP CONSTRAINT notice_finalization_kind_check;
ALTER TABLE content.notice_finalization ADD CONSTRAINT notice_finalization_kind_check
  CHECK (kind IN ('reply', 'mention', 'thread_watch', 'board_activity'));

-- migrate:down
DELETE FROM content.notice WHERE kind = 'board_activity';
DELETE FROM content.notice_finalization WHERE kind = 'board_activity';
ALTER TABLE content.notice DROP CONSTRAINT notice_kind_check;
ALTER TABLE content.notice ADD CONSTRAINT notice_kind_check
  CHECK (kind IN ('reply', 'mention', 'thread_watch', 'moderation_decision'));
ALTER TABLE content.notice_finalization DROP CONSTRAINT notice_finalization_kind_check;
ALTER TABLE content.notice_finalization ADD CONSTRAINT notice_finalization_kind_check
  CHECK (kind IN ('reply', 'mention', 'thread_watch'));
DROP TABLE content.board_watch_notice_work;
DROP TABLE content.board_watch;
DROP INDEX content.thread_watch_management_idx;
