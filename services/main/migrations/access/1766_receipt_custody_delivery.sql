-- Native Main-stream positions are allocated atomically with the graph proof.
-- Reconciliation binds the owner outbox to that position before proof retirement.
ALTER TABLE access.command_custody
  ADD COLUMN data_epoch text,
  ADD COLUMN stream_sequence numeric(100,0),
  ADD CONSTRAINT command_custody_stream_position CHECK (
    (data_epoch IS NULL) = (stream_sequence IS NULL)
    AND (stream_sequence IS NULL OR stream_sequence > 0)
  );
CREATE UNIQUE INDEX command_custody_stream_position
  ON access.command_custody(data_epoch, stream_sequence) WHERE stream_sequence IS NOT NULL;
