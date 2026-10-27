-- migrate:up
ALTER TABLE library.published_log ALTER COLUMN session_id DROP NOT NULL;

-- migrate:down
-- Forward only: retained published snapshots may outlive their source sessions.
