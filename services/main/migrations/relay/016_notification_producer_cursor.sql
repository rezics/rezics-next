-- Notification consumers follow only batches acknowledged by the graph relay.
CREATE TABLE relay.notification_producer_cursor (
    consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 128),
    data_epoch text NOT NULL CHECK (data_epoch <> ''),
    sequence numeric NOT NULL DEFAULT 0 CHECK (sequence >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
