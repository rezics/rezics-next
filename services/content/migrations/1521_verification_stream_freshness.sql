-- Admitted evidence roots, lineage outputs and observation inputs all belong
-- to the evidence author. That immutable source principal is the natural
-- journal stream; unrelated authors neither share a writable head nor add work
-- to another author's continuation. The mutation actor need not be its owner.
-- Drain the old source writers, then old singleton readers, before changing
-- their journal. Taking the singleton DDL lock before journal DDL prevents a
-- reader holding it from waiting on journal DDL while DROP waits for that reader.
LOCK TABLE verification.lineage_head, verification.observation_disposition_head
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE verification.lineage_change_head IN ACCESS EXCLUSIVE MODE;

ALTER TABLE verification.invalidation
  ADD COLUMN stream_principal uuid,
  ADD COLUMN source_xid xid8,
  ADD COLUMN source_epoch bigint,
  ADD CONSTRAINT invalidation_source_stream CHECK (source_xid IS NULL OR
    (stream_principal IS NOT NULL AND source_epoch IS NOT NULL AND producer = 'content'
      AND kind IN ('source-observation', 'source-disposition')));

-- Applied 1520 events retain their committed sequence for bounded legacy
-- catch-up. Their real transaction IDs cannot be reconstructed; NULL explicitly
-- distinguishes them from source events published after this migration.
-- The migration holds ACCESS EXCLUSIVE on the journal. Completed work rejects
-- runtime updates, so suspend that guard only for this metadata backfill and
-- restore it in the same transaction; state, payload and cursors stay intact.
ALTER TABLE verification.invalidation DISABLE TRIGGER invalidation_monotone;
UPDATE verification.invalidation i SET stream_principal = o.principal_id
  FROM source.observation o
  WHERE i.producer = 'content'
    AND i.kind IN ('source-observation', 'source-disposition')
    AND i.local_sequence IS NOT NULL AND i.reference = o.id::text;
ALTER TABLE verification.invalidation ENABLE TRIGGER invalidation_monotone;
CREATE INDEX invalidation_source_stream_order
  ON verification.invalidation (stream_principal, source_epoch, source_xid, id)
  WHERE source_xid IS NOT NULL;
CREATE INDEX invalidation_source_stream_legacy
  ON verification.invalidation (stream_principal, local_sequence)
  WHERE source_xid IS NULL AND local_sequence IS NOT NULL;

ALTER TABLE verification.lineage_walk
  ADD COLUMN stream_principal uuid,
  ADD COLUMN freshness_snapshot text NOT NULL DEFAULT '0:0:',
  ADD COLUMN freshness_target text,
  ADD COLUMN freshness_phase integer NOT NULL DEFAULT 0 CHECK (freshness_phase BETWEEN 0 AND 2),
  ADD COLUMN freshness_xid xid8 NOT NULL DEFAULT '0',
  ADD COLUMN freshness_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  ADD COLUMN freshness_hole integer NOT NULL DEFAULT 0 CHECK (freshness_hole >= 0),
  ADD COLUMN source_epoch bigint;
UPDATE verification.lineage_walk w SET stream_principal = e.principal_id,
  source_epoch = (SELECT version FROM reading_position.generation WHERE singleton)
  FROM verification.evidence_set_revision e WHERE e.id = w.evidence_revision;
ALTER TABLE verification.lineage_walk ALTER COLUMN stream_principal SET NOT NULL;
ALTER TABLE verification.lineage_walk ALTER COLUMN source_epoch SET NOT NULL;

-- Old/direct-SQL mixed-owner witnesses cannot be certified by one author
-- stream. Preserve the durable frontier, but refuse its stale proof. Newly
-- discovered observations are checked against this same stream by the store.
UPDATE verification.lineage_walk_observation witness SET stale = true
  FROM verification.lineage_walk w, source.observation o
  WHERE witness.walk_id = w.id AND witness.observation_id = o.id
    AND o.principal_id <> w.stream_principal;

-- A native snapshot records both its upper boundary and in-progress holes.
-- Readers seek those holes and new events in bounded pages; a late lower-xid
-- commit cannot disappear behind a maximum sequence or an xmin-only cursor.
-- https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT
CREATE OR REPLACE FUNCTION verification.lineage_walk_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_kind text; change_head text; change_event text; owner_principal uuid; restore_epoch bigint;
BEGIN
  IF TG_TABLE_NAME = 'lineage_head' THEN
    IF TG_OP = 'UPDATE' AND NEW.revision = OLD.revision THEN RETURN NULL; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.head = OLD.head THEN RETURN NULL; END IF;
  END IF;
  -- Reuse the existing restore epoch. Shared reads do not serialize source
  -- writers; only an explicit restore advances this control row after draining
  -- appenders. Native XIDs from a logical copy cannot certify its new epoch.
  SELECT version INTO restore_epoch FROM reading_position.generation WHERE singleton FOR SHARE;
  -- The mutation already locks its natural head; the immutable source owner
  -- lookup adds no lock shared by independent source writers or proof readers.
  SELECT principal_id INTO owner_principal FROM source.observation
    WHERE id = NEW.observation_id;
  IF TG_TABLE_NAME = 'lineage_head' THEN
    change_kind := 'source-observation'; change_head := NEW.revision::text;
    change_event := 'lineage:' || NEW.observation_id || ':' || NEW.revision;
  ELSE
    change_kind := 'source-disposition'; change_head := NEW.head::text;
    change_event := 'source-disposition:' || NEW.head;
  END IF;
  PERFORM verification.record_invalidation(change_kind, NEW.observation_id::text, change_head, change_event);
  UPDATE verification.invalidation SET stream_principal = owner_principal, source_xid = pg_current_xact_id(), source_epoch = restore_epoch
    WHERE producer = 'content' AND event_key = change_event;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION verification.guard_walk_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.local_sequence IS NOT NULL AND NEW.local_sequence IS DISTINCT FROM OLD.local_sequence)
    OR (OLD.stream_principal IS NOT NULL AND NEW.stream_principal IS DISTINCT FROM OLD.stream_principal)
    OR (OLD.source_xid IS NOT NULL AND NEW.source_xid IS DISTINCT FROM OLD.source_xid)
    OR (OLD.source_epoch IS NOT NULL AND NEW.source_epoch IS DISTINCT FROM OLD.source_epoch)
    OR (OLD.walks_complete AND NOT NEW.walks_complete)
    OR (OLD.cursor_walk IS NOT NULL AND (NEW.cursor_walk IS NULL OR NEW.cursor_walk < OLD.cursor_walk)) THEN
    RAISE EXCEPTION 'walk invalidation work may only advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TABLE verification.lineage_change_head;
