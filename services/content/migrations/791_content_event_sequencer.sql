-- Content writers append a receipt and its event without an owner position, so
-- unrelated writes never wait on one shared row. Only the sequencer below takes
-- content.owner_control: after commit it numbers every visible unsequenced
-- receipt, in insertion order, at the next contiguous positions of the current
-- epoch. A transaction that commits late is numbered by a later run and is never
-- skipped; no transaction counter is involved, so a logical restore (pg_dump does
-- not carry it) neither stalls nor skips. Consumers read only numbered rows.
ALTER TABLE content.receipt ADD COLUMN entry bigint;
CREATE SEQUENCE content.receipt_entry_seq OWNED BY content.receipt.entry;
-- Rows recorded before this migration are already numbered and keep a NULL entry.
ALTER TABLE content.receipt ALTER COLUMN entry SET DEFAULT nextval('content.receipt_entry_seq');
ALTER TABLE content.receipt ALTER COLUMN data_epoch DROP NOT NULL,
  ALTER COLUMN sequence DROP NOT NULL,
  ADD CONSTRAINT receipt_position_pair CHECK ((data_epoch IS NULL) = (sequence IS NULL)),
  ADD CONSTRAINT receipt_pending_entry CHECK (sequence IS NOT NULL OR entry IS NOT NULL);
CREATE INDEX receipt_pending_idx ON content.receipt (entry) WHERE sequence IS NULL;

ALTER TABLE content.outbox ALTER COLUMN data_epoch DROP NOT NULL,
  ALTER COLUMN sequence DROP NOT NULL,
  ADD CONSTRAINT outbox_position_pair CHECK ((data_epoch IS NULL) = (sequence IS NULL));
-- One event per receipt: the sequencer gives each event its receipt's position.
CREATE UNIQUE INDEX outbox_operation_idx ON content.outbox (operation_id);

-- Owner rows reference their receipt by operation; position copies stop here.
-- A position unique only as a partial index is no row-lock key, so numbering a
-- receipt never waits on a foreign-key check that shares it.
ALTER TABLE content.outbox DROP CONSTRAINT outbox_data_epoch_sequence_fkey;
ALTER TABLE content.comment DROP CONSTRAINT comment_data_epoch_sequence_fkey,
  ALTER COLUMN data_epoch DROP NOT NULL, ALTER COLUMN sequence DROP NOT NULL;
ALTER TABLE media.asset_state DROP CONSTRAINT asset_state_data_epoch_sequence_fkey,
  ALTER COLUMN data_epoch DROP NOT NULL, ALTER COLUMN sequence DROP NOT NULL;
ALTER TABLE media.selection_revision DROP CONSTRAINT selection_revision_data_epoch_sequence_fkey,
  ALTER COLUMN data_epoch DROP NOT NULL, ALTER COLUMN sequence DROP NOT NULL;
ALTER TABLE export.manifest DROP CONSTRAINT manifest_terminal_receipt;
ALTER TABLE content.receipt DROP CONSTRAINT receipt_data_epoch_sequence_key;
CREATE UNIQUE INDEX receipt_position_idx ON content.receipt (data_epoch, sequence)
  WHERE sequence IS NOT NULL;

-- Receipts and events stay immutable except for their one position assignment.
CREATE FUNCTION content.assign_position_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sequence IS NULL AND NEW.sequence IS NOT NULL
    AND to_jsonb(OLD) - 'data_epoch' - 'sequence' = to_jsonb(NEW) - 'data_epoch' - 'sequence' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'immutable Content record' USING ERRCODE = '23514';
END $$;
CREATE OR REPLACE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON content.receipt
  FOR EACH ROW EXECUTE FUNCTION content.assign_position_once();
CREATE OR REPLACE TRIGGER outbox_immutable BEFORE UPDATE OR DELETE ON content.outbox
  FOR EACH ROW EXECUTE FUNCTION content.assign_position_once();

-- The sequencer. Returns the number of receipts it numbered, or NULL when another
-- run holds the position row (that run, or the caller's next poll, covers the
-- rest). Call it in its own transaction: the lock is held until commit.
CREATE FUNCTION content.sequence_events(batch integer) RETURNS integer
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
DECLARE
  control record;
  assigned integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM content.receipt WHERE sequence IS NULL) THEN RETURN 0; END IF;
  SELECT data_epoch, sequence INTO control FROM content.owner_control WHERE singleton
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Under READ COMMITTED this statement takes a snapshot after the lock, so it
  -- sees every earlier run's numbers and every receipt committed before it.
  WITH pending AS (
    SELECT operation_id, row_number() OVER (ORDER BY entry) AS n
    FROM (SELECT operation_id, entry FROM content.receipt WHERE sequence IS NULL
      ORDER BY entry LIMIT batch) next
  ), receipts AS (
    UPDATE content.receipt r SET data_epoch = control.data_epoch, sequence = control.sequence + p.n
    FROM pending p WHERE r.operation_id = p.operation_id
    RETURNING r.operation_id, r.data_epoch, r.sequence
  ), events AS (
    UPDATE content.outbox o SET data_epoch = r.data_epoch, sequence = r.sequence
    FROM receipts r WHERE o.operation_id = r.operation_id
  )
  SELECT count(*) INTO assigned FROM receipts;
  IF assigned > 0 THEN
    UPDATE content.owner_control SET sequence = sequence + assigned WHERE singleton;
  END IF;
  RETURN assigned;
END $$;

-- One round trip for a writer after its commit: its receipt's position, numbering
-- pending receipts first when needed. NULL while another run holds the row.
CREATE FUNCTION content.event_position(operation text, OUT data_epoch uuid, OUT sequence bigint)
LANGUAGE plpgsql AS $$
BEGIN
  SELECT r.data_epoch, r.sequence INTO data_epoch, sequence
    FROM content.receipt r WHERE r.operation_id = operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content receipt is absent' USING ERRCODE = 'P0002';
  END IF;
  IF sequence IS NULL AND content.sequence_events(500) IS NOT NULL THEN
    SELECT r.data_epoch, r.sequence INTO data_epoch, sequence
      FROM content.receipt r WHERE r.operation_id = operation;
  END IF;
END $$;
