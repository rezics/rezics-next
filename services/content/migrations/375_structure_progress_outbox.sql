-- Reader progress joins the shared Content owner position so projections can
-- replay it in order with every other Content-side command after a restore.
INSERT INTO content.receipt_action (action) VALUES ('structure.progress') ON CONFLICT DO NOTHING;

ALTER TABLE structure.progress_command
  ADD COLUMN content_operation text UNIQUE,
  ADD COLUMN first_read boolean NOT NULL DEFAULT false,
  ADD COLUMN first_finish boolean NOT NULL DEFAULT false;

CREATE INDEX progress_command_first_finish_idx ON structure.progress_command
  (principal_issuer, principal_subject, structure, occurrence, result_completed);
