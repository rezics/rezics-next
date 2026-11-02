-- migrate:up
-- A distinct transactional domain. The canonical partition/event head is never advanced.
-- Installed nullable originals remain legacy-unpositioned, permanently and without backfill.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint
    WHERE conrelid IN ('core.operational_work_original'::regclass,'core.operational_work_mapping'::regclass)
      AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%source_position IS NULL%'
        OR pg_get_constraintdef(oid) LIKE '%log_gap%')
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tbl,c.conname); END LOOP;
END; $$;
ALTER TABLE core.operational_work_original
  ADD COLUMN source_domain text NOT NULL DEFAULT 'legacy-unpositioned',
  ALTER COLUMN log_gap DROP NOT NULL;
ALTER TABLE core.operational_work_mapping
  ADD COLUMN source_domain text NOT NULL DEFAULT 'legacy-unpositioned',
  ALTER COLUMN log_gap DROP NOT NULL;
ALTER TABLE core.operational_work_original ADD CONSTRAINT operational_work_original_position_domain CHECK(
  (source_domain='legacy-unpositioned' AND source_position IS NULL AND
    log_gap IS NOT DISTINCT FROM 'operational-work-original-log-position-unavailable') OR
  (source_domain='operational-work/v1' AND source_position IS NOT NULL AND source_position>0 AND log_gap IS NULL));
ALTER TABLE core.operational_work_mapping ADD CONSTRAINT operational_work_mapping_position_domain CHECK(
  (source_domain='legacy-unpositioned' AND source_position IS NULL AND
    log_gap IS NOT DISTINCT FROM 'operational-work-original-log-position-unavailable') OR
  (source_domain='operational-work/v1' AND source_position IS NOT NULL AND source_position>0 AND log_gap IS NULL));
CREATE UNIQUE INDEX operational_work_original_position ON core.operational_work_original(partition_no,source_position)
  WHERE source_domain='operational-work/v1';
CREATE UNIQUE INDEX operational_work_mapping_position ON core.operational_work_mapping(partition_no,source_partition,source_position)
  WHERE source_domain='operational-work/v1';

-- One permanent row per native source partition. This is a locked transactional counter,
-- never a sequence, an independently committed allocation or a canonical event Stamp.
CREATE TABLE core.operational_work_head (
  partition_no integer PRIMARY KEY REFERENCES core.partition(partition_no),
  domain text NOT NULL DEFAULT 'operational-work/v1' CHECK(domain='operational-work/v1'),
  epoch integer NOT NULL CHECK(epoch>0),
  generation bigint NOT NULL CHECK(generation>0),
  position bigint NOT NULL CHECK(position>0),
  custody_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  workflow_id text COLLATE "C" NOT NULL CHECK(octet_length(workflow_id)<=256),
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  deadline bigint NOT NULL CHECK(deadline>0)
);
CREATE FUNCTION core.operational_work_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p core.partition; g bigint;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'operational History head is permanent' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.partition_no<>OLD.partition_no OR NEW.domain<>OLD.domain OR
      NEW.position<>OLD.position+1) THEN
    RAISE EXCEPTION 'operational History head must advance exactly once' USING ERRCODE='23514';
  END IF;
  -- INSERT ON CONFLICT executes this BEFORE INSERT with position=1, then BEFORE UPDATE.
  IF TG_OP='INSERT' AND NEW.position<>1 THEN
    RAISE EXCEPTION 'operational History head must start at one' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM core.partition WHERE partition_no=NEW.partition_no FOR SHARE;
  SELECT generation INTO g FROM core.history_family_domain WHERE singleton FOR SHARE;
  IF p.write_state IS DISTINCT FROM 'active' OR p.epoch IS DISTINCT FROM NEW.epoch OR g IS DISTINCT FROM NEW.generation THEN
    RAISE EXCEPTION 'operational-work-source-restore-fence-changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_head_guard BEFORE INSERT OR UPDATE OR DELETE ON core.operational_work_head
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_head_guard();
CREATE TRIGGER operational_work_head_no_truncate BEFORE TRUNCATE ON core.operational_work_head
  FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_head_guard();
ALTER TABLE core.operational_work_head ENABLE ALWAYS TRIGGER operational_work_head_guard;
ALTER TABLE core.operational_work_head ENABLE ALWAYS TRIGGER operational_work_head_no_truncate;

CREATE FUNCTION core.operational_work_position_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h core.operational_work_head;
BEGIN
  IF NEW.source_domain='legacy-unpositioned' THEN RETURN NEW; END IF;
  SELECT * INTO h FROM core.operational_work_head WHERE partition_no=NEW.partition_no FOR SHARE;
  IF h.position IS DISTINCT FROM NEW.source_position OR h.generation IS DISTINCT FROM NEW.source_generation OR
     h.custody_id IS DISTINCT FROM NEW.custody_id OR h.transaction_id IS DISTINCT FROM NEW.transaction_id OR
     h.workflow_id IS DISTINCT FROM NEW.workflow_id OR h.request_digest IS DISTINCT FROM NEW.request_digest OR
     h.deadline IS DISTINCT FROM NEW.deadline THEN
    RAISE EXCEPTION 'operational-work-native-position-binding-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_position_binding BEFORE INSERT ON core.operational_work_original
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_position_binding();
ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_position_binding;

CREATE OR REPLACE FUNCTION core.operational_work_require_native_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o core.operational_work_original; h core.operational_work_head; p core.partition; g bigint;
BEGIN
  SELECT * INTO STRICT o FROM core.operational_work_original
    WHERE partition_no=NEW.partition_no AND custody_id=NEW.custody_id;
  IF NOT o.sealed OR o.source_epoch IS NULL THEN
    RAISE EXCEPTION 'operational-work-native-commit-fence-unavailable' USING ERRCODE='23514';
  END IF;
  IF o.source_domain='legacy-unpositioned' THEN RETURN NULL; END IF;
  -- Executor already holds partition, family and head in that order. These exact reads verify
  -- the actual original, not a later head observation relabelled as an original position.
  SELECT * INTO p FROM core.partition WHERE partition_no=o.partition_no FOR SHARE;
  SELECT generation INTO g FROM core.history_family_domain WHERE singleton FOR SHARE;
  SELECT * INTO h FROM core.operational_work_head WHERE partition_no=o.partition_no FOR SHARE;
  IF p.write_state IS DISTINCT FROM 'active' OR p.epoch IS DISTINCT FROM o.source_epoch OR
    g IS DISTINCT FROM o.source_generation OR h.epoch IS DISTINCT FROM o.source_epoch OR
    h.generation IS DISTINCT FROM o.source_generation OR h.position IS DISTINCT FROM o.source_position OR
    h.custody_id IS DISTINCT FROM o.custody_id OR h.transaction_id IS DISTINCT FROM o.transaction_id OR
    h.workflow_id IS DISTINCT FROM o.workflow_id OR h.request_digest IS DISTINCT FROM o.request_digest OR
    h.deadline IS DISTINCT FROM o.deadline OR o.deadline<=floor(extract(epoch FROM clock_timestamp())*1000) THEN
    RAISE EXCEPTION 'operational-work-native-commit-fence-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
-- A counter allocation cannot commit without its exact sealed original, even if an escaped
-- caller catches a failed SDK/registration statement or attempts an unused direct allocation.
CREATE FUNCTION core.operational_work_head_bound() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM core.operational_work_original o WHERE o.partition_no=NEW.partition_no AND
      o.custody_id=NEW.custody_id AND o.transaction_id=NEW.transaction_id AND o.workflow_id=NEW.workflow_id AND
      o.request_digest=NEW.request_digest AND o.deadline=NEW.deadline AND o.source_domain=NEW.domain AND
      o.source_epoch=NEW.epoch AND o.source_generation=NEW.generation AND o.source_position=NEW.position AND o.sealed) THEN
    RAISE EXCEPTION 'operational-work-native-position-binding-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER operational_work_head_bound AFTER INSERT OR UPDATE ON core.operational_work_head
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.operational_work_head_bound();
ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_require_native_seal;
ALTER TABLE core.operational_work_head ENABLE ALWAYS TRIGGER operational_work_head_bound;

-- Receiver checks only its local immutable projection. There is no cross-home source query
-- or FK here: the released, private committed resolver supplies the source binding.
CREATE FUNCTION core.operational_work_mapping_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_domain='legacy-unpositioned' THEN RETURN NEW; END IF;
  IF NEW.source->'stamp' IS DISTINCT FROM jsonb_build_object('domain',NEW.source_domain,
       'partition',NEW.source_partition,'epoch',NEW.source_epoch,'generation',NEW.source_generation::text,
       'position',NEW.source_position::text) OR
     NEW.source->>'position' IS DISTINCT FROM NEW.source_position::text OR
     NEW.source->>'transactionId' IS DISTINCT FROM NEW.source_transaction::text OR
     NEW.source->>'custodyId' IS DISTINCT FROM NEW.custody_id::text OR
     NEW.source->>'workflowId' IS DISTINCT FROM NEW.workflow_id OR
     NEW.source->>'digest' IS DISTINCT FROM encode(NEW.request_digest,'hex') OR
     NEW.source->>'gap' IS DISTINCT FROM 'operational-work-source-currentness-unavailable' THEN
    RAISE EXCEPTION 'operational-work-receiving-stamp-binding-changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_mapping_stamp BEFORE INSERT ON core.operational_work_mapping
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_mapping_stamp();
ALTER TABLE core.operational_work_mapping ENABLE ALWAYS TRIGGER operational_work_mapping_stamp;
-- Existing immutable role, SDK/native retirement and receiving guards deliberately remain closed.

-- migrate:down
-- Forward only: permanent counters, originals and receiving obligations survive restore/replay.
