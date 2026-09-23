-- Operational handoff for Main's first bounded RDF outbox consumer.
-- Apply to the relay's private PostgreSQL database, not through a product route.
CREATE SCHEMA relay;

CREATE TABLE relay.checkpoint (
    consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 128),
    data_epoch text NOT NULL CHECK (data_epoch <> ''),
    sequence numeric NOT NULL DEFAULT 0 CHECK (sequence >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE relay.delivered_event (
    source text NOT NULL,
    event_id text NOT NULL,
    data_epoch text NOT NULL,
    sequence numeric NOT NULL CHECK (sequence > 0),
    envelope jsonb NOT NULL,
    delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source, event_id)
);
CREATE INDEX delivered_event_position ON relay.delivered_event (data_epoch, sequence);
