-- migrate:up
-- Separate facts: no existing numeric value or opaque manual unit becomes an Episode identity.
ALTER TABLE library.progress_session ADD COLUMN episode_completed_count integer NOT NULL DEFAULT 0
  CHECK (episode_completed_count BETWEEN 0 AND 20000);
CREATE TABLE library.progress_episode (
  route integer NOT NULL,
  session_id uuid NOT NULL,
  episode_subject_id uuid NOT NULL,
  added_at timestamptz NOT NULL,
  PRIMARY KEY (route, session_id, episode_subject_id),
  FOREIGN KEY (route, session_id) REFERENCES library.progress_session (route, session_id)
);
-- migrate:down
-- Forward only: personal completion facts survive definition rollback.
