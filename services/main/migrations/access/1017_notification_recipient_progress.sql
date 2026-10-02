-- A recipient page is a work budget, never a follower ceiling. Progress commits
-- with each page's intents; source cursors advance only after the last page.
CREATE TABLE access.notification_recipient_progress(source_owner text NOT NULL,source_event text NOT NULL,
  topic text NOT NULL,after_principal uuid,complete boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(source_owner,source_event,topic));
CREATE INDEX notification_recipient_progress_retention ON access.notification_recipient_progress(updated_at);
