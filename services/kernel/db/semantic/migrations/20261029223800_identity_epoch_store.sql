-- migrate:up
-- Scoped native control. P=1 is enforced by the locked home row and unique pending slot.
ALTER TABLE semantic.identity_epoch_control DROP CONSTRAINT identity_epoch_control_partition_no_check;
ALTER TABLE semantic.identity_epoch_control DROP CONSTRAINT identity_epoch_control_check1;
ALTER TABLE semantic.identity_epoch_control ADD COLUMN allocated_epoch bigint NOT NULL DEFAULT 1;
UPDATE semantic.identity_epoch_control SET published_epoch=1;
INSERT INTO semantic.identity_epoch_control(partition_no,published_epoch)
SELECT n,1 FROM generate_series(1,4095) n;
ALTER TABLE semantic.identity_epoch_job DROP CONSTRAINT identity_epoch_job_partition_no_check;
ALTER TABLE semantic.identity_epoch_job DROP CONSTRAINT identity_epoch_job_epoch_key;
DROP INDEX semantic.identity_epoch_one_pending;
CREATE UNIQUE INDEX identity_epoch_one_pending ON semantic.identity_epoch_job(partition_no) WHERE state='pending';
CREATE UNIQUE INDEX identity_epoch_job_home_epoch ON semantic.identity_epoch_job(partition_no,epoch);
ALTER TABLE semantic.identity_epoch_change DROP CONSTRAINT identity_epoch_change_partition_no_check;
ALTER TABLE semantic.identity_epoch_ack DROP CONSTRAINT identity_epoch_ack_partition_no_check;
ALTER TABLE semantic.identity_epoch_effect_receipt DROP CONSTRAINT identity_epoch_effect_receipt_partition_no_check;
ALTER TABLE semantic.identity_epoch_group DROP CONSTRAINT identity_epoch_group_partition_no_check;
ALTER TABLE semantic.identity_epoch_original DROP CONSTRAINT identity_epoch_original_partition_no_check;
ALTER TABLE semantic.identity_epoch_legacy_member DROP CONSTRAINT identity_epoch_legacy_member_partition_no_check;
ALTER TABLE semantic.identity_epoch_bootstrap_custody DROP CONSTRAINT identity_epoch_bootstrap_custody_partition_no_check;
ALTER TABLE semantic.identity_epoch_group ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE semantic.identity_epoch_group ADD COLUMN owner_epoch integer;
UPDATE semantic.identity_epoch_group g SET owner_epoch=p.epoch FROM core.partition p WHERE p.partition_no=g.partition_no;
ALTER TABLE semantic.identity_epoch_group ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE semantic.identity_epoch_group ADD COLUMN ready boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.identity_epoch_mapping ADD COLUMN control_partition integer;
ALTER TABLE semantic.identity_epoch_mapping ADD COLUMN control_group uuid;
ALTER TABLE semantic.identity_epoch_mapping ADD COLUMN source_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE semantic.identity_epoch_mapping ADD COLUMN owner_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE semantic.identity_epoch_group ADD COLUMN published_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE semantic.identity_epoch_group ADD COLUMN pending_job uuid;
ALTER TABLE semantic.identity_epoch_group ADD COLUMN pending_epoch bigint;
ALTER TABLE semantic.identity_epoch_original ADD COLUMN generation uuid;
UPDATE semantic.identity_epoch_original o SET generation=g.generation FROM semantic.identity_epoch_group g WHERE g.terminal=o.terminal;
ALTER TABLE semantic.identity_epoch_original ALTER COLUMN generation SET NOT NULL;
ALTER TABLE semantic.identity_epoch_original DROP CONSTRAINT identity_epoch_original_pkey;
ALTER TABLE semantic.identity_epoch_original ADD PRIMARY KEY(generation,original);
CREATE UNIQUE INDEX identity_epoch_current_original ON semantic.identity_epoch_original(partition_no,original) WHERE present;
CREATE INDEX identity_epoch_generation_original ON semantic.identity_epoch_original(generation,original) WHERE present;
CREATE INDEX identity_epoch_original_source ON semantic.identity_epoch_original(source_partition,original) WHERE present;
CREATE TABLE semantic.identity_epoch_input (
  partition_no integer NOT NULL,
  job_id uuid NOT NULL REFERENCES semantic.identity_epoch_job(job_id),
  terminal uuid NOT NULL,
  generation uuid NOT NULL,
  basis_version bigint NOT NULL,
  original_count bigint NOT NULL,
  PRIMARY KEY(job_id,terminal)
);
CREATE TABLE semantic.identity_epoch_bootstrap_topology (
  partition_no integer PRIMARY KEY CHECK(partition_no=0),
  next_partition integer NOT NULL DEFAULT 0 CHECK(next_partition BETWEEN 0 AND 4095),
  remaining integer NOT NULL DEFAULT 4096 CHECK(remaining BETWEEN 0 AND 4096)
);
INSERT INTO semantic.identity_epoch_bootstrap_topology(partition_no) VALUES(0);
CREATE TABLE semantic.identity_epoch_bootstrap_topology_home (
  source_partition integer PRIMARY KEY CHECK(source_partition BETWEEN 0 AND 4095),
  closed boolean NOT NULL DEFAULT false
);
INSERT INTO semantic.identity_epoch_bootstrap_topology_home(source_partition) SELECT n FROM generate_series(0,4095) n;
CREATE INDEX identity_epoch_topology_open_home ON semantic.identity_epoch_bootstrap_topology_home(source_partition) WHERE NOT closed;
ALTER TABLE semantic.identity_epoch_bootstrap_custody DROP CONSTRAINT identity_epoch_bootstrap_custody_pkey;
ALTER TABLE semantic.identity_epoch_bootstrap_custody ADD PRIMARY KEY(partition_no,source_partition,source_generation);
CREATE TABLE semantic.identity_epoch_topology_custody (
  source_partition integer PRIMARY KEY CHECK(source_partition BETWEEN 0 AND 4095),
  source_generation bigint NOT NULL,
  source_epoch integer NOT NULL
);
ALTER TABLE semantic.identity_epoch_bootstrap_home ADD COLUMN owner_epoch integer;
ALTER TABLE semantic.identity_epoch_bootstrap_home ADD COLUMN needs_work boolean NOT NULL DEFAULT true;
CREATE INDEX identity_epoch_bootstrap_repair ON semantic.identity_epoch_bootstrap_home(partition_no) WHERE needs_work;
ALTER TABLE semantic.identity_epoch_bootstrap_home ADD COLUMN sealed_generation bigint;
ALTER TABLE semantic.identity_epoch_bootstrap_home ADD COLUMN sealed_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_bootstrap_home ADD COLUMN sealed_epoch integer;
ALTER TABLE semantic.identity_epoch_bootstrap_home ADD COLUMN sealed_position bigint;
ALTER TABLE semantic.identity_epoch_topology_custody ADD COLUMN source_transaction_id uuid NOT NULL;
ALTER TABLE semantic.identity_epoch_topology_custody ADD COLUMN source_position bigint NOT NULL;
ALTER TABLE semantic.identity_epoch_bootstrap_page ADD COLUMN caught_up boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.identity_epoch_bootstrap_page ADD COLUMN acknowledged boolean NOT NULL DEFAULT false;
CREATE INDEX identity_epoch_bootstrap_unacknowledged ON semantic.identity_epoch_bootstrap_page(partition_no,generation) WHERE NOT acknowledged;
DROP TRIGGER identity_epoch_bootstrap_page_immutable ON semantic.identity_epoch_bootstrap_page;
DROP TRIGGER identity_epoch_bootstrap_row_immutable ON semantic.identity_epoch_bootstrap_row;
-- Export payloads are reclaimed only after actual receiving custody, followed by source ACK.
CREATE FUNCTION semantic.capture_identity_epoch_key(r integer,id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=r/16;
  INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES(r,id)
  ON CONFLICT(route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
  UPDATE semantic.identity_epoch_group SET ready=false,version=version+1
  WHERE partition_no=r/16 AND terminal=id AND pending_job IS NULL;
END; $$;
CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='merge_member' THEN
    IF TG_OP='UPDATE' AND (OLD.route,OLD.subject_id,OLD.member_id)=(NEW.route,NEW.subject_id,NEW.member_id) THEN RETURN NEW; END IF;
    IF TG_OP IN ('UPDATE','DELETE') THEN
      INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original) VALUES(OLD.route,OLD.subject_id,OLD.member_id)
      ON CONFLICT(route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
      PERFORM semantic.capture_identity_epoch_key(OLD.route,OLD.subject_id);
    END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN
      INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original) VALUES(NEW.route,NEW.subject_id,NEW.member_id)
      ON CONFLICT(route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
      PERFORM semantic.capture_identity_epoch_key(NEW.route,NEW.subject_id);
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM semantic.capture_identity_epoch_key(OLD.route,OLD.subject_id); END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN PERFORM semantic.capture_identity_epoch_key(NEW.route,NEW.subject_id); END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
-- Backlink and identity revisions share the source-local dirty obligation with redirects and membership.
CREATE TRIGGER identity_epoch_capture_backlink AFTER UPDATE OR DELETE ON semantic.account_agent_subject
FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();

-- migrate:down
-- Forward-only native identity cutover; rolling back would discard retained custody.
