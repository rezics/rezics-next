-- migrate:up
-- Keep diary continuation bounded by live rows rather than retained private tombstones.
DROP INDEX library.progress_session_diary_seek;
CREATE INDEX progress_session_diary_seek
  ON library.progress_session (route, account_id, started_at DESC, session_id DESC)
  WHERE state <> 'retired';

-- migrate:down
-- Forward only: native readers and lifecycle indexes move together.
