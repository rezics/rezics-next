-- migrate:up
-- PREPARE reserves the existing home slot without publishing any pending claim.
ALTER TABLE semantic.identity_epoch_control ADD COLUMN prepare_job uuid;
ALTER TABLE semantic.identity_epoch_control ADD COLUMN prepare_epoch bigint;
ALTER TABLE semantic.identity_epoch_job ADD COLUMN prearm_phase text NOT NULL DEFAULT 'prearm-open'
 CHECK (prearm_phase IN ('prearm-open','prearm-sealed','claiming'));
ALTER TABLE semantic.identity_epoch_job ADD COLUMN prearm_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_job ADD COLUMN cancellation_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_admission_plan ADD COLUMN prepared_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_admission_plan ADD COLUMN prepared_epoch integer;
ALTER TABLE semantic.identity_epoch_admission_plan ADD COLUMN prepared_position bigint;
ALTER TABLE semantic.identity_epoch_admission_plan ADD COLUMN released boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.identity_epoch_input ADD COLUMN prearm_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE semantic.identity_epoch_input ADD COLUMN prearm_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_input ADD COLUMN prearm_epoch integer;
ALTER TABLE semantic.identity_epoch_input ADD COLUMN prearm_position bigint;
ALTER TABLE semantic.identity_epoch_admission_attempt DROP CONSTRAINT identity_epoch_admission_attempt_state_check;
ALTER TABLE semantic.identity_epoch_admission_attempt ADD CHECK (state IN ('prepared','acquired','closed'));
ALTER TABLE semantic.identity_epoch_admission_receipt DROP CONSTRAINT identity_epoch_admission_receipt_stage_check;
ALTER TABLE semantic.identity_epoch_admission_receipt ADD CHECK (stage IN ('prepared','acquired','closed'));

CREATE TABLE semantic.identity_epoch_prearm_bridge (
 partition_no integer NOT NULL, generation uuid NOT NULL, terminal uuid NOT NULL,
 owner_epoch integer NOT NULL, basis_version bigint NOT NULL, bridge_version bigint NOT NULL DEFAULT 0,
 job_id uuid, job_epoch bigint, scope_digest text,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,generation), UNIQUE(partition_no,erasure_key),
 CHECK ((job_id IS NULL)=(job_epoch IS NULL))
);
-- Source owns registration/capture truth. This control-home inverse contains only native
-- ticket locators; Source must take its enrollment receipt into its own forward custody.
CREATE TABLE semantic.identity_epoch_prearm_inverse (
 partition_no integer NOT NULL, generation uuid NOT NULL, original uuid NOT NULL,
 scope_key text NOT NULL, registration text NOT NULL, scope jsonb NOT NULL, capture_id text NOT NULL,
 source_partition integer NOT NULL, source_owner_epoch integer NOT NULL,
 transaction_id uuid NOT NULL, retired boolean NOT NULL DEFAULT false,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,generation,original,scope_key,registration), UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,generation) REFERENCES semantic.identity_epoch_prearm_bridge(partition_no,generation),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TABLE semantic.identity_epoch_prearm_directory (
 partition_no integer NOT NULL, job_id uuid NOT NULL, job_epoch bigint NOT NULL, generation uuid NOT NULL,
 terminal uuid NOT NULL, basis_version bigint NOT NULL, owner_epoch integer NOT NULL,
 scope_digest text NOT NULL, attempt_transaction_id uuid NOT NULL,
 sequence bigint NOT NULL DEFAULT 0, after_original uuid, after_scope text, after_registration text,
 exhausted boolean NOT NULL DEFAULT false, sealed_transaction_id uuid, released boolean NOT NULL DEFAULT false,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,job_id,generation), UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,attempt_transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE INDEX identity_epoch_prearm_directory_unsealed ON semantic.identity_epoch_prearm_directory(partition_no,job_id,generation)
 WHERE sealed_transaction_id IS NULL;
-- A page holds one retained structural ticket. Empty exhaustion is an explicit native page.
-- Metadata, receipt and index work remain part of the same bounded step.
CREATE TABLE semantic.identity_epoch_prearm_page (
 partition_no integer NOT NULL, job_id uuid NOT NULL, generation uuid NOT NULL, sequence bigint NOT NULL,
 page_id uuid NOT NULL, transaction_id uuid NOT NULL, original uuid, scope_key text, registration text,
 scope jsonb, capture_id text, source_partition integer, source_owner_epoch integer,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,job_id,generation,sequence), UNIQUE(partition_no,page_id), UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,job_id,generation) REFERENCES semantic.identity_epoch_prearm_directory(partition_no,job_id,generation),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id),
 CHECK ((original IS NULL)=(scope IS NULL))
);
CREATE TABLE semantic.identity_epoch_prearm_disposition (
 partition_no integer NOT NULL, page_id uuid NOT NULL, stage text NOT NULL CHECK(stage IN ('unsafe','cancelled')),
 transaction_id uuid NOT NULL, source_receipt jsonb,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,page_id,stage), UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,page_id) REFERENCES semantic.identity_epoch_prearm_page(partition_no,page_id),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE INDEX identity_epoch_prearm_page_order ON semantic.identity_epoch_prearm_page(partition_no,job_id,generation,sequence,page_id);
CREATE TABLE semantic.identity_epoch_prearm_custody (
 partition_no integer NOT NULL, job_id uuid NOT NULL, generation uuid NOT NULL, sequence bigint NOT NULL,
 directory_partition integer NOT NULL, page_id uuid NOT NULL, directory_receipt jsonb NOT NULL,
 source_receipt jsonb, empty boolean NOT NULL, transaction_id uuid NOT NULL,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,job_id,generation,sequence), UNIQUE(partition_no,directory_partition,page_id),
 UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TABLE semantic.identity_epoch_prearm_claim (
 partition_no integer NOT NULL, job_id uuid NOT NULL, job_epoch bigint NOT NULL, scope_digest text NOT NULL,
 seal jsonb NOT NULL, transaction_id uuid NOT NULL,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,job_id), UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);

CREATE FUNCTION semantic.guard_identity_prearm_inverse() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;
BEGIN
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge
 WHERE partition_no=coalesce(NEW.partition_no,OLD.partition_no) AND generation=coalesce(NEW.generation,OLD.generation) FOR UPDATE;
 IF NOT FOUND OR b.job_id IS NOT NULL THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_original m
 JOIN semantic.identity_epoch_group g ON g.partition_no=m.partition_no AND g.generation=m.generation
 JOIN core.partition p ON p.partition_no=g.partition_no AND p.epoch=g.owner_epoch AND p.write_state='active'
 WHERE m.partition_no=NEW.partition_no AND m.generation=NEW.generation AND m.original=NEW.original
 AND g.terminal=b.terminal AND g.version=b.basis_version AND g.pending_job IS NULL)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_epoch_prearm_inverse_gate BEFORE INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_prearm_inverse
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_inverse();

-- Group publication/retirement may not invalidate an input pinned by PREPARE.
CREATE FUNCTION semantic.guard_identity_prearm_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;
BEGIN
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=OLD.partition_no AND generation=OLD.generation FOR UPDATE;
 IF FOUND AND b.job_id IS NOT NULL AND (TG_OP='DELETE' OR
 (NEW.partition_no,NEW.terminal,NEW.generation,NEW.version,NEW.owner_epoch,NEW.observed_count) IS DISTINCT FROM
 (OLD.partition_no,OLD.terminal,OLD.generation,OLD.version,OLD.owner_epoch,OLD.observed_count))
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_attempt a WHERE a.partition_no=OLD.partition_no
 AND a.job_id=b.job_id AND a.job_epoch=b.job_epoch AND a.state='acquired'
 AND current_setting('semantic.identity_prearm_effect_job',true)=b.job_id::text)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_epoch_prearm_group_gate BEFORE UPDATE OR DELETE ON semantic.identity_epoch_group
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_group();

CREATE FUNCTION semantic.prepare_identity_epoch_admission(p_home integer,p_job uuid,p_epoch bigint,p_scope text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_epoch_admission_attempt;c semantic.identity_epoch_control;h semantic.identity_epoch_admission_handoff;i record;b semantic.identity_epoch_prearm_bridge;
BEGIN
 SELECT * INTO c FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 SELECT * INTO a FROM semantic.identity_epoch_admission_attempt WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
 IF FOUND THEN
  IF a.state='closed' OR a.job_epoch<>p_epoch OR a.scope_digest<>p_scope THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  RETURN;
 END IF;
 SELECT * INTO h FROM semantic.identity_epoch_admission_handoff WHERE partition_no=p_home AND job_id=p_job;
 IF NOT FOUND OR h.job_epoch<>p_epoch OR h.scope_digest<>p_scope THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF (c.pending_job IS NOT NULL AND c.pending_job<>p_job) OR (c.prepare_job IS NOT NULL AND c.prepare_job<>p_job)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 FOR i IN SELECT * FROM jsonb_to_recordset(h.inputs) r(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer) ORDER BY terminal LOOP
  PERFORM 1 FROM semantic.identity_epoch_group g JOIN core.partition p ON p.partition_no=g.partition_no
   AND p.epoch=g.owner_epoch AND p.write_state='active' WHERE g.partition_no=p_home AND g.terminal=i.terminal
   AND g.generation=i.generation AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch AND g.pending_job IS NULL FOR UPDATE OF g;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  INSERT INTO semantic.identity_epoch_prearm_bridge(partition_no,generation,terminal,owner_epoch,basis_version)
   VALUES(p_home,i.generation,i.terminal,i.owner_epoch,i.basis_version) ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=p_home AND generation=i.generation FOR UPDATE;
  IF b.terminal<>i.terminal OR b.owner_epoch<>i.owner_epoch OR b.basis_version<>i.basis_version OR
   (b.job_id IS NOT NULL AND (b.job_id<>p_job OR b.job_epoch<>p_epoch OR b.scope_digest<>p_scope))
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  UPDATE semantic.identity_epoch_prearm_bridge SET job_id=p_job,job_epoch=p_epoch,scope_digest=p_scope,bridge_version=bridge_version+1
   WHERE partition_no=p_home AND generation=i.generation;
 END LOOP;
 INSERT INTO semantic.identity_epoch_admission_attempt(partition_no,job_id,job_epoch,scope_digest,state)
  VALUES(p_home,p_job,p_epoch,p_scope,'prepared');
 UPDATE semantic.identity_epoch_control SET prepare_job=p_job,prepare_epoch=p_epoch,allocated_epoch=greatest(allocated_epoch,p_epoch) WHERE partition_no=p_home;
END; $$;

CREATE OR REPLACE FUNCTION semantic.acquire_identity_epoch_admission(p_home integer,p_job uuid,p_epoch bigint,p_scope text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_epoch_admission_attempt;h semantic.identity_epoch_admission_handoff;
BEGIN
 PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home AND prepare_job=p_job AND prepare_epoch=p_epoch FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 SELECT * INTO a FROM semantic.identity_epoch_admission_attempt WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
 IF NOT FOUND OR a.state='closed' OR a.job_epoch<>p_epoch OR a.scope_digest<>p_scope THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF a.state='acquired' THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_prearm_claim WHERE partition_no=p_home AND job_id=p_job AND job_epoch=p_epoch AND scope_digest=p_scope)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 SELECT * INTO h FROM semantic.identity_epoch_admission_handoff WHERE partition_no=p_home AND job_id=p_job;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(h.inputs) i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
 LEFT JOIN semantic.identity_epoch_prearm_directory d ON d.partition_no=p_home AND d.job_id=p_job AND d.generation=i.generation
  AND d.job_epoch=p_epoch AND d.basis_version=i.basis_version AND d.owner_epoch=i.owner_epoch AND NOT d.released
 LEFT JOIN semantic.identity_epoch_group g ON g.partition_no=p_home AND g.terminal=i.terminal AND g.generation=i.generation
  AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch
 LEFT JOIN core.partition p ON p.partition_no=p_home AND p.epoch=i.owner_epoch AND p.write_state='active'
 WHERE d.sealed_transaction_id IS NULL OR g.terminal IS NULL OR p.partition_no IS NULL)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 UPDATE semantic.identity_epoch_admission_attempt SET state='acquired' WHERE partition_no=p_home AND job_id=p_job;
 UPDATE semantic.identity_epoch_group SET pending_job=p_job,pending_epoch=p_epoch WHERE partition_no=p_home
  AND terminal IN (SELECT i.terminal FROM jsonb_to_recordset(h.inputs) i(terminal uuid));
 UPDATE semantic.identity_epoch_control SET pending_job=p_job,pending_epoch=p_epoch WHERE partition_no=p_home;
END; $$;

-- Closing an attempt never frees its reservation or bridge. Source cancellation custody comes first.
CREATE OR REPLACE FUNCTION semantic.close_identity_epoch_admission(p_home integer,p_job uuid,p_epoch bigint,p_scope text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_epoch_admission_attempt;
BEGIN
 PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
 SELECT * INTO a FROM semantic.identity_epoch_admission_attempt WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
 IF FOUND AND (a.job_epoch<>p_epoch OR a.scope_digest<>p_scope) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 INSERT INTO semantic.identity_epoch_admission_attempt(partition_no,job_id,job_epoch,scope_digest,state)
 VALUES(p_home,p_job,p_epoch,p_scope,'closed') ON CONFLICT(partition_no,job_id) DO UPDATE SET state='closed';
END; $$;

CREATE TRIGGER identity_epoch_prearm_page_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_prearm_page
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_prearm_disposition_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_prearm_disposition
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_prearm_custody_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_prearm_custody
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_prearm_claim_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_prearm_claim
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

ALTER TABLE semantic.identity_epoch_input ADD COLUMN prearm_cancelled_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_prearm_directory ADD COLUMN cancel_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE semantic.identity_epoch_prearm_directory ADD COLUMN cancelled_transaction_id uuid;
CREATE INDEX identity_epoch_prearm_input_unsealed ON semantic.identity_epoch_input(partition_no,job_id,terminal)
 WHERE prearm_transaction_id IS NULL;
CREATE INDEX identity_epoch_prearm_input_uncancelled ON semantic.identity_epoch_input(partition_no,job_id,terminal)
 WHERE prearm_cancelled_transaction_id IS NULL;
CREATE INDEX identity_epoch_prearm_bridge_held ON semantic.identity_epoch_prearm_bridge(partition_no,job_id,generation) WHERE job_id IS NOT NULL;

-- Moving an owner while native PREPARE holds exist requires a custody transfer; until
-- that transfer is implemented the old owner refuses the move, including write suspension.
CREATE FUNCTION semantic.guard_identity_prearm_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='DELETE' OR (NEW.epoch,NEW.write_state) IS DISTINCT FROM (OLD.epoch,OLD.write_state))
 AND (EXISTS(SELECT 1 FROM semantic.identity_epoch_control WHERE partition_no=OLD.partition_no AND prepare_job IS NOT NULL)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold WHERE partition_no=OLD.partition_no AND NOT closed))
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_epoch_prearm_owner_gate BEFORE UPDATE OR DELETE ON core.partition
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_owner();


CREATE TABLE semantic.identity_epoch_prearm_decision (
 partition_no integer NOT NULL,job_id uuid NOT NULL,job_epoch bigint NOT NULL,scope_digest text NOT NULL,
 stage text NOT NULL CHECK(stage IN ('sealed','cancelled')),transaction_id uuid NOT NULL,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,job_id,stage),UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TRIGGER identity_epoch_prearm_decision_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_prearm_decision
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE FUNCTION semantic.capture_identity_prearm_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=coalesce((to_jsonb(NEW)->>'transaction_id')::uuid,
   nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_bridge_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_bridge
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_bridge
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_inverse_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_inverse
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_inverse
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_directory_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_directory
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_directory
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_page_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_page
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_page
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_disposition_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_disposition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_disposition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_custody_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_custody
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_custody
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_claim_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER identity_epoch_prearm_decision_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_decision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_decision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE OR REPLACE FUNCTION semantic.capture_erasure_source_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_present boolean:=false; v_original uuid; v_old_terminal uuid; v_identity_version bigint; v_mapped_terminal uuid;
 v_slot uuid; v_candidate uuid; v_property_id text; v_release_id text; v_context uuid; v_source_name text; v_external_id text; v_field_group text;
BEGIN
 -- Closing an empty native home and admitting a late role serialize on its actual command gate.
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_seal s WHERE s.partition_no=NEW.partition_no AND s.account_id=NEW.account_id) THEN
  RAISE EXCEPTION 'Semantic erased Source role admission is sealed' USING ERRCODE='23514';
 END IF;
 CASE NEW.store
 WHEN 'release_composite' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.release_composite r WHERE r.erasure_key=NEW.record_key AND extension_route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'fact' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.statement_id,r.property,r.release,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.fact r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'revision' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,r.release,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.revision r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'candidate' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.candidate_id,r.property,r.release,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.candidate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'acceptance' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.acceptance r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'acceptance_current' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.candidate_id,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.acceptance_current r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'adoption' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.adoption r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'retraction' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.retraction r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'hidden_candidate' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.hidden_candidate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'moderation' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.moderation r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'context' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.context r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'context_extension' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.context_extension r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'context_extension_activation' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.context_extension_activation r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'definition_release' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.definition_release r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'definition_activation' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.definition_activation r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'external_claim' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.external_claim r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'source_candidate' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,r.source,r.external_id,r.field_group INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.source_candidate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'provider_review_queue_key' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.provider_review_queue_key r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'provider_review_queue_entry' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.provider_review_queue_entry r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'statement_disclosure' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,r.property,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.statement_disclosure r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'subject' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.subject r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'redirect' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.redirect r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'account_agent_subject' THEN SELECT true,r.agent_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.account_agent_subject r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'account_agent_moved_link' THEN SELECT true,r.source_subject_id,NULL::uuid,NULL::uuid,r.statement_id,r.property,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.account_agent_moved_link r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'outbound_link' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.statement_id,r.property,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.outbound_link r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'inbound_link' THEN SELECT true,r.source_subject_id,NULL::uuid,NULL::uuid,r.statement_id,r.property,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.inbound_link r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'identity_epoch_job' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_job r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_home_gate' THEN SELECT true,r.original,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_home_gate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'identity_epoch_mapping' THEN SELECT true,r.original,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_mapping r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'identity_epoch_ack' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_ack r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_attempt' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_attempt r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_plan' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_plan r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_receipt' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_receipt r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_source' THEN SELECT true,r.original,r.terminal,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_source r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_change' THEN SELECT true,r.original,r.previous_terminal,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_change r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_effect_receipt' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_effect_receipt r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_input' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_input r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_step' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_step r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'zone' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM zones.zone r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'write_basis' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.erasure_provenance r WHERE r.record_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_receiving_plan' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_plan WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_receiving_record' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_record WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_receiving_effect' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_effect WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_receiving_custody' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_custody WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_bridge' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_inverse' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_inverse WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_directory' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_directory WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_page' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_page WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_disposition' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_disposition WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_custody' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_custody WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_claim' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_claim WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_decision' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_decision WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 ELSE v_present:=false;
 END CASE;
 IF v_candidate IS NOT NULL AND v_original IS NOT NULL AND
 (get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11))/16=NEW.partition_no THEN
  SELECT coalesce(v_slot,c.slot_id),coalesce(v_property_id,c.property),coalesce(v_release_id,c.release)
  INTO v_slot,v_property_id,v_release_id FROM semantic.candidate c
  WHERE c.route=(get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11)) AND c.subject_id=v_original AND c.candidate_id=v_candidate;
 END IF;
 IF v_original IS NOT NULL AND (get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11))/16=NEW.partition_no THEN
  SELECT m.terminal,m.epoch INTO v_mapped_terminal,v_identity_version
  FROM semantic.identity_epoch_mapping m WHERE m.route=(get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11)) AND m.original=v_original;
  v_old_terminal:=coalesce(v_old_terminal,v_mapped_terminal);
 END IF;
 INSERT INTO semantic.erasure_source_record(partition_no,account_id,role,store,record_key,delivery_position,
 source_transaction_id,source_position,native_present,original,previous_terminal,identity_epoch,
 slot_id,candidate_id,property,release,context_id,source_name,external_id,field_group)
 VALUES(NEW.partition_no,NEW.account_id,NEW.role,NEW.store,NEW.record_key,NEW.delivery_position,
 NEW.source_transaction_id,NEW.source_position,coalesce(v_present,false),v_original,v_old_terminal,v_identity_version,
 v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
CREATE FUNCTION semantic.guard_identity_prearm_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND semantic.erasure_mutation_allowed(TG_TABLE_NAME,OLD.partition_no*16,OLD.erasure_key)
 AND NEW.scope='{}'::jsonb AND NEW.capture_id='' AND
 (to_jsonb(NEW)-ARRAY['scope','capture_id'])=(to_jsonb(OLD)-ARRAY['scope','capture_id'])
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Immutable identity pre-arm page';
END; $$;
DROP TRIGGER identity_epoch_prearm_page_immutable ON semantic.identity_epoch_prearm_page;
CREATE TRIGGER identity_epoch_prearm_page_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_prearm_page
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_page();

-- Captured membership is immutable even to the admitted job. Stage results in a new
-- generation; retaining the input cut is independent of changing its current group header.
CREATE FUNCTION semantic.guard_identity_prearm_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;g uuid;h integer;
BEGIN
 g:=coalesce(NEW.generation,OLD.generation);h:=coalesce(NEW.partition_no,OLD.partition_no);
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=h AND generation=g FOR UPDATE;
 IF FOUND AND b.job_id IS NOT NULL
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='UPDATE' AND (NEW.partition_no,NEW.generation) IS DISTINCT FROM (OLD.partition_no,OLD.generation) THEN
  SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=OLD.partition_no AND generation=OLD.generation FOR UPDATE;
  IF FOUND AND b.job_id IS NOT NULL
  THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_epoch_prearm_membership_gate BEFORE INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_original
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_membership();

-- migrate:down
-- Forward only: retained native attempt fences and custody cannot be discarded.
