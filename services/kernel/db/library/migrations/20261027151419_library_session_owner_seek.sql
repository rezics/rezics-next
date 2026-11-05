-- migrate:up
CREATE INDEX progress_session_owner_seek
  ON library.progress_session (route, account_id, session_id);

-- migrate:down
-- Forward only: retain the bounded owner/session maintenance seek.
