-- Upgrade populated checkpoints without replaying completed work.
ALTER TABLE content.projection_checkpoint ADD COLUMN scan_sequence bigint;
UPDATE content.projection_checkpoint SET scan_sequence = sequence;
ALTER TABLE content.projection_checkpoint ALTER COLUMN scan_sequence SET DEFAULT 0;
ALTER TABLE content.projection_checkpoint ALTER COLUMN scan_sequence SET NOT NULL;
ALTER TABLE content.projection_checkpoint ADD CHECK (scan_sequence >= sequence);
CREATE TABLE content.projection_pending (
  consumer text NOT NULL REFERENCES content.projection_checkpoint(consumer),
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id uuid NOT NULL REFERENCES content.outbox(id),
  target text NOT NULL,
  PRIMARY KEY (consumer, data_epoch, sequence)
);
CREATE INDEX projection_pending_target ON content.projection_pending(consumer, data_epoch, target, sequence);
-- Retry scheduling seeks target heads, never walks a backlog of later events.
CREATE TABLE content.projection_target (
  consumer text NOT NULL,
  data_epoch uuid NOT NULL,
  target text NOT NULL,
  first_sequence bigint NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, data_epoch, target),
  FOREIGN KEY (consumer, data_epoch, first_sequence)
    REFERENCES content.projection_pending(consumer, data_epoch, sequence) ON DELETE CASCADE
);
CREATE INDEX projection_target_retry ON content.projection_target(consumer, data_epoch, attempted_at, first_sequence);
