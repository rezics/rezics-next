-- Retain the public timeline positions and the notification checkpoint. Only
-- the notification worker numbers new events after their writers commit.
ALTER TABLE access.editorial_event DROP CONSTRAINT editorial_event_pkey,
  ALTER COLUMN sequence DROP NOT NULL,
  ADD COLUMN entry bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ADD COLUMN epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN xid xid8 NOT NULL DEFAULT '0'::xid8;
UPDATE access.editorial_event SET epoch = (SELECT generation FROM access.recovery_fence WHERE id);
ALTER TABLE access.editorial_event ALTER COLUMN xid SET DEFAULT pg_current_xact_id();
CREATE UNIQUE INDEX editorial_event_position ON access.editorial_event(sequence) WHERE sequence IS NOT NULL;
CREATE INDEX editorial_event_pending ON access.editorial_event(epoch,xid,entry) WHERE sequence IS NULL;

CREATE OR REPLACE FUNCTION access.editorial_event_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT generation INTO NEW.epoch FROM access.recovery_fence WHERE id FOR SHARE;
  NEW.sequence := NULL;
  RETURN NEW;
END $$;
CREATE FUNCTION access.editorial_event_assign_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sequence IS NULL AND NEW.sequence IS NOT NULL
    AND to_jsonb(OLD) - 'sequence' = to_jsonb(NEW) - 'sequence' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'editorial records are immutable' USING ERRCODE = '23514';
END $$;
CREATE OR REPLACE TRIGGER editorial_event_immutable BEFORE UPDATE OR DELETE ON access.editorial_event
  FOR EACH ROW EXECUTE FUNCTION access.editorial_event_assign_once();
CREATE FUNCTION access.sequence_editorial_events(batch integer) RETURNS integer
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
DECLARE head bigint; assigned integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.editorial_event WHERE sequence IS NULL) THEN RETURN 0; END IF;
  SELECT sequence INTO head FROM access.editorial_event_clock WHERE id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH pending AS (
    SELECT entry,row_number() OVER (ORDER BY epoch,xid,entry) AS n FROM (
      SELECT entry,epoch,xid FROM access.editorial_event WHERE sequence IS NULL AND (epoch,xid) <
        ((SELECT generation FROM access.recovery_fence WHERE id),pg_snapshot_xmin(pg_current_snapshot()))
      ORDER BY epoch,xid,entry LIMIT batch) rows
  ), numbered AS (
    UPDATE access.editorial_event e SET sequence = head + p.n FROM pending p WHERE e.entry = p.entry RETURNING e.entry
  ) SELECT count(*) INTO assigned FROM numbered;
  IF assigned > 0 THEN UPDATE access.editorial_event_clock SET sequence = head + assigned WHERE id; END IF;
  RETURN assigned;
END $$;
