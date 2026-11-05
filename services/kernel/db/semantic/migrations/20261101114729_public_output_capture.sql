-- migrate:up
-- Preserve the installed native purposes, including independent concurrent additions.
DO $$ DECLARE allowed text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT allowed FROM pg_constraint
 WHERE conrelid='semantic.identity_epoch_native_commit'::regclass
 AND conname='identity_epoch_native_commit_purpose_check';
 ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
 EXECUTE format('ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK ((%s) OR purpose=%L)',allowed,'identity-public-output-capture');
END $$;
-- The Collection home retains the immutable binding and all uncertain foreign sends.
-- Foreign Subject evidence is retained at its actual control home, never joined across homes.
CREATE TABLE semantic.identity_public_output_accepted (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, hold_id uuid NOT NULL, binding_digest text NOT NULL, definition_digest text NOT NULL,
 binding jsonb NOT NULL CHECK(octet_length(binding::text)<=16384),
 definition jsonb NOT NULL CHECK(octet_length(definition::text)<=2097152),
 scope_key text NOT NULL CHECK(scope_key ~ '^[0-9a-f]{64}$'), reservation_id text NOT NULL CHECK(octet_length(reservation_id)<=256), native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TRIGGER identity_public_output_accepted_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_accepted
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_accepted_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_accepted
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_accepted ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_progress (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, version bigint NOT NULL DEFAULT 0 CHECK(version>=0), after_key jsonb,
 exhausted boolean NOT NULL DEFAULT false, manifest_digest text NOT NULL,
 raw_count bigint NOT NULL DEFAULT 0 CHECK(raw_count>=0), canonical_count bigint NOT NULL DEFAULT 0 CHECK(canonical_count>=0),
 pending jsonb CHECK(octet_length(pending::text)<=65536), closure_after bigint NOT NULL DEFAULT 0 CHECK(closure_after>=0),
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TRIGGER identity_public_output_progress_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_progress
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TABLE semantic.identity_public_output_page (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0), predecessor text NOT NULL, manifest_digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536), native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id,version)
);
CREATE TRIGGER identity_public_output_page_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_page
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_page_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_page
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_page ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_original (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, original uuid NOT NULL, terminal uuid NOT NULL, mapping_epoch bigint NOT NULL CHECK(mapping_epoch>0),
 PRIMARY KEY(partition_no,capture_id,original)
);
CREATE TRIGGER identity_public_output_original_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_original
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_original_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_original
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TABLE semantic.identity_public_output_member (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, terminal uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id,terminal)
);
CREATE TRIGGER identity_public_output_member_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_member
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_member_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_member
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TABLE semantic.identity_public_output_seal (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, manifest_digest text NOT NULL, version bigint NOT NULL CHECK(version>=0),
 raw_count bigint NOT NULL CHECK(raw_count>=0), canonical_count bigint NOT NULL CHECK(canonical_count>=0), native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TRIGGER identity_public_output_seal_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_seal
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_seal_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_seal
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_seal ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_fence (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('applied','cancelled')), native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TRIGGER identity_public_output_fence_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_fence
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_fence_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_fence
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_fence ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_disposition (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, hold_id uuid NOT NULL, binding_digest text NOT NULL, kind text NOT NULL CHECK(kind IN ('applied','cancelled')),
 manifest_digest text, seal_transaction_id uuid, native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TRIGGER identity_public_output_disposition_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_disposition
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_disposition_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_disposition
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_disposition ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_transition (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('applied','cancelled')), successor_hold_id uuid,
 CHECK((kind='applied')=(successor_hold_id IS NOT NULL)), native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TRIGGER identity_public_output_transition_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_transition
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_transition_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_transition
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_transition ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_consumer (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_id uuid NOT NULL, consumer_id uuid NOT NULL, native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id,consumer_id)
);
CREATE TRIGGER identity_public_output_consumer_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_consumer
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_consumer_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_consumer
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_consumer ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_subject_slot (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_partition integer NOT NULL CHECK(capture_partition BETWEEN 0 AND 4095),
 capture_id uuid NOT NULL, original uuid NOT NULL, generation uuid NOT NULL, terminal uuid NOT NULL, released boolean NOT NULL,
 PRIMARY KEY(partition_no,capture_partition,capture_id,original)
);
CREATE TRIGGER identity_public_output_subject_slot_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_subject_slot
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TABLE semantic.identity_public_output_subject_cut (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_partition integer NOT NULL,
 capture_id uuid NOT NULL, original uuid NOT NULL, generation uuid NOT NULL, terminal uuid NOT NULL,
 mapping_epoch bigint NOT NULL CHECK(mapping_epoch>0), scope_key text NOT NULL, registration uuid NOT NULL, native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_partition,capture_id,original)
);
CREATE TRIGGER identity_public_output_subject_cut_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_subject_cut
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_subject_cut_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_subject_cut
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_subject_cut ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE semantic.identity_public_output_subject_release (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), capture_partition integer NOT NULL,
 capture_id uuid NOT NULL, original uuid NOT NULL, native_epoch integer NOT NULL CHECK(native_epoch>0), native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_partition,capture_id,original)
);
CREATE TRIGGER identity_public_output_subject_release_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_subject_release
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_subject_release_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_subject_release
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.identity_public_output_subject_release ADD FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION semantic.validate_public_output_native() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purpose text; component semantic.identity_epoch_native_commit;
BEGIN
 purpose:=CASE TG_TABLE_NAME WHEN 'identity_public_output_subject_cut' THEN 'identity-scope-enrollment'
 WHEN 'identity_public_output_subject_release' THEN 'identity-scope-directory-release' ELSE 'identity-public-output-capture' END;
 SELECT * INTO component FROM semantic.identity_epoch_native_commit n
 WHERE (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (NEW.partition_no,NEW.transaction_id,NEW.native_epoch,NEW.native_position) AND n.purpose=purpose;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM core.partition p JOIN core.outbox o
 ON o.partition_no=p.partition_no AND o.epoch=p.epoch
 WHERE p.partition_no=NEW.partition_no AND p.epoch=NEW.native_epoch AND p.position>=NEW.native_position
 AND p.write_state='active' AND p.moved_to IS NULL AND o.position=NEW.native_position AND o.event_seq=0
 AND o.type='com.rezics.semantic.public-output.capture.v1') OR NOT EXISTS (
 SELECT 1 FROM semantic.identity_epoch_native_commit n WHERE n.partition_no=NEW.partition_no
 AND n.transaction_id=NEW.transaction_id AND n.xmin=pg_current_xact_id()::text::xid
 ) THEN RAISE EXCEPTION 'public_output_capture_not_native' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_accepted_native AFTER INSERT ON semantic.identity_public_output_accepted
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_page_native AFTER INSERT ON semantic.identity_public_output_page
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_seal_native AFTER INSERT ON semantic.identity_public_output_seal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_fence_native AFTER INSERT ON semantic.identity_public_output_fence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_disposition_native AFTER INSERT ON semantic.identity_public_output_disposition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_transition_native AFTER INSERT ON semantic.identity_public_output_transition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_consumer_native AFTER INSERT ON semantic.identity_public_output_consumer
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_subject_cut_native AFTER INSERT ON semantic.identity_public_output_subject_cut
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE CONSTRAINT TRIGGER identity_public_output_subject_release_native AFTER INSERT ON semantic.identity_public_output_subject_release
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();
CREATE FUNCTION semantic.validate_public_output_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d semantic.identity_public_output_disposition;
BEGIN
 SELECT * INTO d FROM semantic.identity_public_output_disposition
 WHERE (partition_no,capture_id)=(NEW.partition_no,NEW.capture_id);
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_transition t
 JOIN semantic.identity_epoch_native_commit n ON n.partition_no=t.partition_no AND n.transaction_id=t.transaction_id
 WHERE (t.partition_no,t.capture_id,t.kind,t.transaction_id,t.native_epoch,t.native_position)=
 (d.partition_no,d.capture_id,d.kind,d.transaction_id,d.native_epoch,d.native_position)
 AND t.xmin=n.xmin AND n.xmin=pg_current_xact_id()::text::xid) OR NOT EXISTS(
 SELECT 1 FROM semantic.identity_public_output_accepted a JOIN semantic.identity_public_output_fence f USING(partition_no,capture_id)
 WHERE (a.partition_no,a.capture_id,a.hold_id,a.binding_digest)=(d.partition_no,d.capture_id,d.hold_id,d.binding_digest)
 AND f.kind=d.kind
 ) THEN RAISE EXCEPTION 'public_output_disposition_without_atomic_transition' USING ERRCODE='23514'; END IF;
 IF d.kind='applied' AND NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_seal s
 WHERE (s.partition_no,s.capture_id,s.manifest_digest,s.transaction_id)=
 (d.partition_no,d.capture_id,d.manifest_digest,d.seal_transaction_id))
 THEN RAISE EXCEPTION 'public_output_applied_without_exact_seal' USING ERRCODE='23514'; END IF;
 IF d.kind='cancelled' AND NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_progress p
 WHERE (p.partition_no,p.capture_id)=(d.partition_no,d.capture_id)
 AND p.closure_after>=p.version+CASE WHEN p.pending IS NULL THEN 0 ELSE 1 END)
 THEN RAISE EXCEPTION 'public_output_cancelled_without_subject_closure' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM semantic.identity_public_output_consumer c
 WHERE (c.partition_no,c.capture_id)=(d.partition_no,d.capture_id))
 THEN RAISE EXCEPTION 'public_output_foreign_closure_missing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_disposition_atomic AFTER INSERT ON semantic.identity_public_output_disposition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_transition();
CREATE CONSTRAINT TRIGGER identity_public_output_transition_atomic AFTER INSERT ON semantic.identity_public_output_transition
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_transition();
CREATE FUNCTION semantic.guard_public_output_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.partition_no,NEW.capture_id) IS DISTINCT FROM (OLD.partition_no,OLD.capture_id)
 OR NEW.version<OLD.version OR NEW.version>OLD.version+1 OR NEW.raw_count<OLD.raw_count
 OR NEW.canonical_count<OLD.canonical_count OR (OLD.exhausted AND NOT NEW.exhausted)
 OR NEW.closure_after<OLD.closure_after OR NEW.closure_after>NEW.version+(CASE WHEN NEW.pending IS NULL THEN 0 ELSE 1 END)
 OR (NEW.closure_after>OLD.closure_after AND NEW.closure_after<>OLD.closure_after+1)
 THEN RAISE EXCEPTION 'public_output_progress_cannot_reset' USING ERRCODE='23514'; END IF;
 IF (NEW.version,NEW.after_key,NEW.exhausted,NEW.manifest_digest,NEW.raw_count,NEW.canonical_count,NEW.pending)
 IS DISTINCT FROM (OLD.version,OLD.after_key,OLD.exhausted,OLD.manifest_digest,OLD.raw_count,OLD.canonical_count,OLD.pending)
 AND EXISTS(SELECT 1 FROM semantic.identity_public_output_fence f
 WHERE (f.partition_no,f.capture_id)=(NEW.partition_no,NEW.capture_id))
 THEN RAISE EXCEPTION 'public_output_capture_fenced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_public_output_progress_monotone BEFORE UPDATE OR DELETE ON semantic.identity_public_output_progress
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_progress();
CREATE FUNCTION semantic.guard_public_output_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.partition_no,NEW.capture_partition,NEW.capture_id,NEW.original,NEW.generation,NEW.terminal)
 IS DISTINCT FROM (OLD.partition_no,OLD.capture_partition,OLD.capture_id,OLD.original,OLD.generation,OLD.terminal)
 OR (OLD.released AND NOT NEW.released)
 THEN RAISE EXCEPTION 'public_output_subject_send_cannot_reopen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_public_output_subject_slot_monotone BEFORE UPDATE OR DELETE ON semantic.identity_public_output_subject_slot
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_slot();

-- A seal is a checkpoint of the exact exhausted manifest, never authority to discard custody.
CREATE FUNCTION semantic.guard_public_output_fresh_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_public_output_accepted; p semantic.identity_public_output_progress;
BEGIN
 SELECT * INTO STRICT a FROM semantic.identity_public_output_accepted
 WHERE (partition_no,capture_id)=(NEW.partition_no,NEW.capture_id);
 IF EXISTS(SELECT 1 FROM semantic.identity_public_output_fence f
 WHERE (f.partition_no,f.capture_id)=(NEW.partition_no,NEW.capture_id)) OR NOT EXISTS(
 SELECT 1 FROM semantic.identity_scope_summary s WHERE s.partition_no=a.partition_no AND s.source_key=a.scope_key
 AND s.scope_id=a.capture_id::text AND s.registration=a.hold_id AND s.capture_id=a.capture_id
 AND s.revision=1 AND s.active=0 AND s.state IN ('capturing','ready'))
 THEN RAISE EXCEPTION 'public_output_capture_not_fresh' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT p FROM semantic.identity_public_output_progress
 WHERE (partition_no,capture_id)=(NEW.partition_no,NEW.capture_id);
 IF TG_TABLE_NAME='identity_public_output_seal' THEN
  IF NOT p.exhausted OR p.pending IS NOT NULL OR
  (NEW.version,NEW.manifest_digest,NEW.raw_count,NEW.canonical_count)
  IS DISTINCT FROM (p.version,p.manifest_digest,p.raw_count,p.canonical_count)
  THEN RAISE EXCEPTION 'public_output_seal_not_exhausted_manifest' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='identity_public_output_page' THEN
  IF p.exhausted OR p.pending IS NULL OR NEW.version<>p.version+1 OR NEW.predecessor<>p.manifest_digest
  OR (NEW.body-'receipts')<>p.pending OR jsonb_array_length(NEW.body->'rows')>8
  OR jsonb_array_length(NEW.body->'cuts')>16
  OR jsonb_array_length(NEW.body->'cuts')<>jsonb_array_length(NEW.body->'receipts')
  THEN RAISE EXCEPTION 'public_output_page_not_exact_plan' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_public_output_seal_fresh BEFORE INSERT ON semantic.identity_public_output_seal
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_fresh_write();
CREATE TRIGGER identity_public_output_page_fresh BEFORE INSERT ON semantic.identity_public_output_page
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_fresh_write();
CREATE TRIGGER identity_public_output_consumer_fresh BEFORE INSERT ON semantic.identity_public_output_consumer
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_fresh_write();
ALTER TABLE semantic.identity_public_output_progress ADD FOREIGN KEY(partition_no,capture_id)
 REFERENCES semantic.identity_public_output_accepted(partition_no,capture_id);
ALTER TABLE semantic.identity_public_output_page ADD FOREIGN KEY(partition_no,capture_id)
 REFERENCES semantic.identity_public_output_accepted(partition_no,capture_id);
ALTER TABLE semantic.identity_public_output_seal ADD FOREIGN KEY(partition_no,capture_id)
 REFERENCES semantic.identity_public_output_accepted(partition_no,capture_id);

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Public output custody requires genuine native disposition'; END $$;
