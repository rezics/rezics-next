-- Product-owned durable consumer inbox. A broker may discard its own retained
-- messages; the relay's verified handoff can rebuild these exact envelopes.
CREATE TABLE access.owner_consumer_checkpoint (
    consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 128),
    data_epoch text NOT NULL CHECK (data_epoch <> ''),
    sequence numeric NOT NULL DEFAULT 0 CHECK (sequence >= 0 AND sequence = trunc(sequence)),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE access.owner_consumer_replay (
    consumer text NOT NULL REFERENCES access.owner_consumer_checkpoint(consumer),
    data_epoch text NOT NULL,
    sequence numeric NOT NULL CHECK (sequence > 0 AND sequence = trunc(sequence)),
    event_id text NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
    envelope jsonb NOT NULL,
    rebuilt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (consumer, event_id),
    UNIQUE (consumer, data_epoch, sequence, ordinal)
);
CREATE INDEX owner_consumer_replay_position ON access.owner_consumer_replay
    (consumer, data_epoch, sequence, ordinal);

CREATE FUNCTION access.owner_consumer_replay_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'rebuilt consumer envelope is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER owner_consumer_replay_immutable BEFORE UPDATE OR DELETE
    ON access.owner_consumer_replay FOR EACH ROW
    EXECUTE FUNCTION access.owner_consumer_replay_immutable();
