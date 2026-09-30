-- Durable notification hook. Consumers checkpoint sequence and recheck current
-- disclosure; no candidate payload or private operator identity enters this feed.
CREATE TABLE access.editorial_event_clock (id boolean PRIMARY KEY CHECK (id), sequence bigint NOT NULL);
INSERT INTO access.editorial_event_clock VALUES (true, 0);
CREATE TABLE access.editorial_event (
    sequence bigint PRIMARY KEY,
    id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    proposal uuid NOT NULL REFERENCES access.editorial_proposal(id),
    revision integer NOT NULL,
    kind text NOT NULL CHECK (kind IN ('created','revised','reviewed','applied','rejected','withdrawn',
      'reversal-proposed','apply-pending','apply-stale','apply-cancelled')),
    actor text NOT NULL REFERENCES access.authority_subject(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX editorial_event_timeline ON access.editorial_event (proposal, sequence);
CREATE FUNCTION access.editorial_event_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE access.editorial_event_clock SET sequence = sequence + 1 WHERE id RETURNING sequence INTO NEW.sequence;
    RETURN NEW;
END $$;
CREATE TRIGGER editorial_event_sequence BEFORE INSERT ON access.editorial_event
    FOR EACH ROW EXECUTE FUNCTION access.editorial_event_sequence();
CREATE TRIGGER editorial_event_immutable BEFORE UPDATE OR DELETE ON access.editorial_event
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
