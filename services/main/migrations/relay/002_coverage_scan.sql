-- Ordered offline coverage scans page by source position and stable event ID.
DROP INDEX relay.delivered_event_position;
CREATE INDEX delivered_event_position ON relay.delivered_event (data_epoch, sequence, event_id);
ALTER TABLE relay.checkpoint ADD CONSTRAINT checkpoint_sequence_integral
    CHECK (sequence = trunc(sequence));
ALTER TABLE relay.delivered_event ADD CONSTRAINT delivered_event_sequence_integral
    CHECK (sequence = trunc(sequence));
