-- migrate:up
ALTER TABLE content.notice DROP CONSTRAINT notice_kind_check;
ALTER TABLE content.notice
  ADD CONSTRAINT notice_kind_check
  CHECK (kind IN ('reply', 'mention', 'thread_watch', 'moderation_decision'));

ALTER TABLE content.notice_finalization DROP CONSTRAINT notice_finalization_kind_check;
ALTER TABLE content.notice_finalization
  ADD CONSTRAINT notice_finalization_kind_check
  CHECK (kind IN ('reply', 'mention', 'thread_watch'));

CREATE TABLE content.thread_watch (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  watch_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  watcher_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT thread_watch_watcher_route_check
    CHECK (route = get_byte(uuid_send(watcher_account_id), 10) * 256 + get_byte(uuid_send(watcher_account_id), 11)),
  CONSTRAINT thread_watch_id_route_check
    CHECK (route = get_byte(uuid_send(watch_id), 10) * 256 + get_byte(uuid_send(watch_id), 11)),
  CONSTRAINT thread_watch_created_at_check CHECK (isfinite(created_at)),
  CONSTRAINT thread_watch_identity_key UNIQUE (route, thread_id, watcher_account_id),
  PRIMARY KEY (route, watch_id)
);
CREATE INDEX thread_watch_fanout_idx
  ON content.thread_watch (thread_id, created_at, watch_id) INCLUDE (route, watcher_account_id);
CREATE INDEX thread_watch_account_idx
  ON content.thread_watch (route, watcher_account_id, created_at, thread_id) INCLUDE (watch_id);

CREATE TABLE content.thread_watch_notice_work (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  post_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  published_at timestamptz NOT NULL,
  cursor_created_at timestamptz,
  cursor_route integer,
  cursor_watch_id uuid,
  done boolean NOT NULL DEFAULT false,
  CONSTRAINT thread_watch_notice_work_post_route_check
    CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CONSTRAINT thread_watch_notice_work_thread_route_check
    CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CONSTRAINT thread_watch_notice_work_cursor_check
    CHECK ((cursor_created_at IS NULL) = (cursor_route IS NULL) AND (cursor_route IS NULL) = (cursor_watch_id IS NULL)),
  CONSTRAINT thread_watch_notice_work_cursor_route_check CHECK (cursor_route IS NULL OR cursor_route BETWEEN 0 AND 65535),
  CONSTRAINT thread_watch_notice_work_cursor_watch_route_check
    CHECK (cursor_watch_id IS NULL OR cursor_route = get_byte(uuid_send(cursor_watch_id), 10) * 256 + get_byte(uuid_send(cursor_watch_id), 11)),
  CONSTRAINT thread_watch_notice_work_published_at_check CHECK (isfinite(published_at)),
  PRIMARY KEY (route, post_id)
);
CREATE INDEX thread_watch_notice_work_expire_idx
  ON content.thread_watch_notice_work (route, published_at, post_id);

ALTER TABLE content.account_erasure_progress DROP CONSTRAINT account_erasure_progress_phase_check;
ALTER TABLE content.account_erasure_progress
  ADD CONSTRAINT account_erasure_progress_phase_check
  CHECK (phase IN ('authored', 'uploads', 'reactions', 'moderation', 'notices', 'proof', 'complete'));

-- migrate:down
DROP TABLE content.thread_watch_notice_work;
DROP TABLE content.thread_watch;
DELETE FROM content.notice WHERE kind = 'thread_watch';
DELETE FROM content.notice_finalization WHERE kind = 'thread_watch';

ALTER TABLE content.account_erasure_progress DROP CONSTRAINT account_erasure_progress_phase_check;
UPDATE content.account_erasure_progress SET phase='proof', cursor=NULL WHERE phase='notices';
ALTER TABLE content.account_erasure_progress
  ADD CONSTRAINT account_erasure_progress_phase_check
  CHECK (phase IN ('authored', 'uploads', 'reactions', 'moderation', 'proof', 'complete'));

ALTER TABLE content.notice_finalization DROP CONSTRAINT notice_finalization_kind_check;
ALTER TABLE content.notice_finalization
  ADD CONSTRAINT notice_finalization_kind_check CHECK (kind IN ('reply', 'mention'));
ALTER TABLE content.notice DROP CONSTRAINT notice_kind_check;
ALTER TABLE content.notice
  ADD CONSTRAINT notice_kind_check CHECK (kind IN ('reply', 'mention', 'moderation_decision'));
