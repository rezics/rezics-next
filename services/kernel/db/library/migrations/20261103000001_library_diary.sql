-- migrate:up
-- Immutable recording time, independent of optional person-reported dates.
CREATE INDEX progress_session_diary_seek
  ON library.progress_session (route, account_id, started_at DESC, session_id DESC);

-- Eight bounded navigation slots per owner. No copied session facts or permission decisions.
CREATE TABLE library.diary_navigation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 7),
  navigation_id uuid NOT NULL,
  caller text NOT NULL CHECK (length(caller) = 64),
  epoch integer NOT NULL CHECK (epoch > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (route, account_id, slot),
  UNIQUE (route, account_id, navigation_id)
);

-- migrate:down
-- Forward only.
