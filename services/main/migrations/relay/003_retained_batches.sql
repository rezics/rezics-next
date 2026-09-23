-- Preserve every acknowledged source position, including zero-event progress.
-- Existing handoffs need an operator-verified source backfill before recovery
-- coverage can pass; this migration deliberately does not invent old headers.
CREATE TABLE relay.delivered_batch (
    data_epoch text NOT NULL CHECK (data_epoch <> ''),
    sequence numeric NOT NULL CHECK (sequence > 0 AND sequence = trunc(sequence)),
    batch_id text NOT NULL CHECK (batch_id <> ''),
    routing_epoch text NOT NULL CHECK (routing_epoch <> ''),
    event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 100),
    delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (data_epoch, sequence)
);
