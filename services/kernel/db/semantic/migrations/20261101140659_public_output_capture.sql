-- migrate:up
DO $$ DECLARE allowed text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT allowed FROM pg_constraint
 WHERE conrelid='semantic.identity_epoch_native_commit'::regclass
 AND conname='identity_epoch_native_commit_purpose_check';
 ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
 EXECUTE format('ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK ((%s) OR purpose IN (%L,%L))',
  allowed,'identity-public-output-applied','identity-public-output-cancelled');
END $$;

-- No backfilled zero: an older accepted capture without its original admission gate refuses.
CREATE TABLE semantic.identity_public_output_gate (
 partition_no integer NOT NULL, capture_id uuid NOT NULL, original_epoch bigint NOT NULL CHECK(original_epoch>0),
 receiving_epoch bigint NOT NULL, enrolled_count bigint NOT NULL DEFAULT 0 CHECK(enrolled_count>=0),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','applied','cancelled')),
 native_epoch integer, native_position bigint, transaction_id uuid, native_xid xid8,
 PRIMARY KEY(partition_no,capture_id),
 FOREIGN KEY(partition_no,capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no,capture_id),
 CHECK((state='open' AND receiving_epoch=original_epoch AND transaction_id IS NULL AND native_epoch IS NULL
       AND native_position IS NULL AND native_xid IS NULL)
   OR (state<>'open' AND receiving_epoch=original_epoch+1 AND transaction_id IS NOT NULL
       AND native_epoch IS NOT NULL AND native_position>0 AND native_xid IS NOT NULL))
);
CREATE FUNCTION semantic.guard_public_output_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.partition_no,NEW.capture_id,NEW.original_epoch) IS DISTINCT FROM
   (OLD.partition_no,OLD.capture_id,OLD.original_epoch) OR OLD.state<>'open'
   OR (NEW.state='open' AND NEW.enrolled_count<>OLD.enrolled_count+1)
   OR (NEW.state<>'open' AND NEW.enrolled_count<>OLD.enrolled_count)
 THEN RAISE EXCEPTION 'public_output_enrollment_cannot_reopen'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_public_output_gate_monotone BEFORE UPDATE OR DELETE ON semantic.identity_public_output_gate
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_gate();
CREATE TRIGGER identity_public_output_gate_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_gate
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE FUNCTION semantic.validate_public_output_gate_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_accepted a
  JOIN library.native_public_output_binding b USING(partition_no,capture_id)
  JOIN semantic.identity_public_output_gate g USING(partition_no,capture_id)
  WHERE a.partition_no=NEW.partition_no AND a.capture_id=NEW.capture_id
   AND a.xmin=b.xmin AND a.xmin=g.xmin AND b.native_xid=pg_current_xact_id()
   AND g.state='open' AND g.original_epoch=b.receiving_epoch AND g.receiving_epoch=b.receiving_epoch AND g.enrolled_count=0)
 THEN RAISE EXCEPTION 'public_output_gate_requires_original_acceptance'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_gate_origin AFTER INSERT ON semantic.identity_public_output_gate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_gate_origin();
CREATE FUNCTION semantic.enroll_public_output_consumer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_WHEN='BEFORE' THEN
  PERFORM 1 FROM semantic.identity_public_output_gate WHERE partition_no=NEW.partition_no
   AND capture_id=NEW.capture_id AND state='open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'public_output_consumer_fenced'; END IF;
 ELSE
  UPDATE semantic.identity_public_output_gate SET enrolled_count=enrolled_count+1
   WHERE partition_no=NEW.partition_no AND capture_id=NEW.capture_id AND state='open';
  IF NOT FOUND THEN RAISE EXCEPTION 'public_output_consumer_fenced'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_public_output_consumer_gate BEFORE INSERT ON semantic.identity_public_output_consumer
 FOR EACH ROW EXECUTE FUNCTION semantic.enroll_public_output_consumer();
CREATE TRIGGER identity_public_output_consumer_count AFTER INSERT ON semantic.identity_public_output_consumer
 FOR EACH ROW EXECUTE FUNCTION semantic.enroll_public_output_consumer();

CREATE TABLE semantic.identity_public_output_stage (
 partition_no integer NOT NULL, capture_id uuid NOT NULL, hold_id uuid NOT NULL, binding_digest text NOT NULL,
 original_receiving_epoch bigint NOT NULL CHECK(original_receiving_epoch>0),
 kind text NOT NULL CHECK(kind IN ('applied','cancelled')), purpose text NOT NULL,
 successor_hold_id uuid, cancellation_epoch bigint, manifest_digest text, seal_transaction_id uuid,
 native_epoch integer NOT NULL, native_position bigint NOT NULL CHECK(native_position>0), transaction_id uuid NOT NULL,
 native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(partition_no,capture_id),
 FOREIGN KEY(partition_no,capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no,capture_id),
 FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
  REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='applied' AND purpose='identity-public-output-applied' AND successor_hold_id IS NOT NULL
   AND successor_hold_id<>hold_id AND cancellation_epoch IS NULL AND manifest_digest IS NOT NULL AND manifest_digest ~ '^[0-9a-f]{64}$'
   AND seal_transaction_id IS NOT NULL)
 OR (kind='cancelled' AND purpose='identity-public-output-cancelled' AND successor_hold_id IS NULL
   AND cancellation_epoch IS NOT NULL AND cancellation_epoch=original_receiving_epoch+1 AND manifest_digest IS NULL AND seal_transaction_id IS NULL))
);
CREATE TRIGGER identity_public_output_stage_immutable BEFORE UPDATE OR DELETE ON semantic.identity_public_output_stage
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_public_output_stage_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_stage
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE OR REPLACE FUNCTION semantic.validate_public_output_native() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
 expected:=CASE TG_TABLE_NAME WHEN 'identity_public_output_subject_cut' THEN 'identity-scope-enrollment'
  WHEN 'identity_public_output_subject_release' THEN 'identity-scope-directory-release'
  WHEN 'identity_public_output_fence' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  WHEN 'identity_public_output_disposition' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  WHEN 'identity_public_output_transition' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  WHEN 'identity_public_output_stage' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  ELSE 'identity-public-output-capture' END;
 IF NOT EXISTS (SELECT 1 FROM semantic.identity_epoch_native_commit n
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position=n.position
  JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
  WHERE (n.partition_no,n.transaction_id,n.epoch,n.position)=
   (NEW.partition_no,NEW.transaction_id,NEW.native_epoch,NEW.native_position)
   AND n.purpose=expected AND n.xmin=pg_current_xact_id()::text::xid AND o.xmin=n.xmin
   AND p.write_state='active' AND p.moved_to IS NULL AND o.type='com.rezics.semantic.public-output.capture.v1')
 THEN RAISE EXCEPTION 'public_output_capture_not_native' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_stage_native AFTER INSERT ON semantic.identity_public_output_stage
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();

CREATE FUNCTION semantic.validate_public_output_accepted_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM library.native_public_output_binding b
  JOIN semantic.identity_public_output_gate g ON g.partition_no=b.partition_no AND g.capture_id=b.capture_id
  WHERE b.partition_no=NEW.partition_no AND b.capture_id=NEW.capture_id AND b.hold_id=NEW.hold_id
   AND b.payload=NEW.binding AND b.binding_digest=NEW.binding_digest AND b.definition_digest=NEW.definition_digest
   AND b.xmin=pg_current_xact_id()::text::xid AND b.native_xid=pg_current_xact_id() AND g.xmin=b.xmin
   AND g.original_epoch=b.receiving_epoch AND g.receiving_epoch=b.receiving_epoch AND g.state='open' AND g.enrolled_count=0)
 THEN RAISE EXCEPTION 'public_output_accepted_requires_native_binding_and_gate'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_accepted_binding AFTER INSERT ON semantic.identity_public_output_accepted
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_accepted_binding();

-- One keyed disposition only; no scan of captures or foreign homes. Subject closure progresses
-- only after actual released-home receipts; unknown receiver/writer closure keeps enrolled_count positive.
CREATE OR REPLACE FUNCTION semantic.validate_public_output_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM semantic.identity_public_output_stage s
  JOIN semantic.identity_public_output_disposition d USING(partition_no,capture_id,hold_id,binding_digest,kind,native_epoch,native_position,transaction_id)
  JOIN semantic.identity_public_output_transition t USING(partition_no,capture_id,kind,native_epoch,native_position,transaction_id)
  JOIN semantic.identity_public_output_accepted a USING(partition_no,capture_id)
  JOIN semantic.identity_public_output_gate g USING(partition_no,capture_id)
  JOIN library.native_public_output_transition nt ON nt.partition_no=s.partition_no AND nt.capture_id=s.capture_id
   AND nt.hold_id=s.hold_id AND nt.binding_digest=s.binding_digest AND nt.transaction_id=s.transaction_id
   AND nt.epoch=s.native_epoch AND nt.position=s.native_position AND nt.kind=s.kind AND nt.purpose=s.purpose
  JOIN library.native_public_output_hold h ON h.partition_no=s.partition_no AND h.hold_id=s.hold_id
  JOIN library.native_public_output_receiving r ON r.partition_no=s.partition_no AND r.capture_id=s.capture_id
  LEFT JOIN library.native_public_output_hold k ON k.partition_no=s.partition_no AND k.hold_id=s.successor_hold_id
  LEFT JOIN semantic.identity_public_output_seal seal ON seal.partition_no=s.partition_no AND seal.capture_id=s.capture_id
  JOIN semantic.identity_public_output_progress progress ON progress.partition_no=s.partition_no AND progress.capture_id=s.capture_id
  WHERE s.partition_no=NEW.partition_no AND s.capture_id=NEW.capture_id AND s.native_xid=pg_current_xact_id()
   AND s.xmin=d.xmin AND s.xmin=t.xmin AND s.xmin=nt.xmin AND nt.native_xid=s.native_xid
   AND a.hold_id=s.hold_id AND a.binding_digest=s.binding_digest AND a.native_epoch=s.native_epoch
   AND s.original_receiving_epoch=(a.binding->'tuple'->'identity'->>'receivingEpoch')::bigint
   AND g.state=s.kind AND g.enrolled_count=0 AND g.receiving_epoch=s.original_receiving_epoch+1
   AND r.state=s.kind AND r.receiving_epoch=g.receiving_epoch AND r.transaction_id=s.transaction_id
   AND h.role='predecessor' AND h.consumed_by=s.transaction_id AND h.xmin=s.xmin
   AND t.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id
   AND nt.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id
   AND d.manifest_digest IS NOT DISTINCT FROM s.manifest_digest AND d.seal_transaction_id IS NOT DISTINCT FROM s.seal_transaction_id
   AND ((s.kind='applied' AND k.role='successor' AND k.capture_id=s.capture_id AND k.consumed_by IS NULL
     AND k.transaction_id=s.transaction_id AND k.native_xid=s.native_xid AND k.xmin=s.xmin
     AND seal.manifest_digest=s.manifest_digest AND seal.transaction_id=s.seal_transaction_id)
    OR (s.kind='cancelled' AND nt.cancellation_epoch=s.cancellation_epoch
      AND s.cancellation_epoch=g.receiving_epoch
      AND progress.closure_after>=progress.version+CASE WHEN progress.pending IS NULL THEN 0 ELSE 1 END)))
 THEN RAISE EXCEPTION 'public_output_disposition_without_atomic_transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_stage_atomic AFTER INSERT ON semantic.identity_public_output_stage
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_transition();

CREATE FUNCTION semantic.validate_public_output_gate_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='open' THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_fence f
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=f.partition_no AND n.transaction_id=f.transaction_id
   AND n.epoch=f.native_epoch AND n.position=f.native_position
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position=n.position
  JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
  JOIN semantic.identity_public_output_gate g ON g.partition_no=f.partition_no AND g.capture_id=f.capture_id
  WHERE g.partition_no=NEW.partition_no AND g.capture_id=NEW.capture_id AND g.state=f.kind
   AND g.native_epoch=f.native_epoch AND g.native_position=f.native_position AND g.transaction_id=f.transaction_id
   AND g.xmin=f.xmin AND g.xmin=n.xmin AND n.xmin=o.xmin AND g.native_xid=pg_current_xact_id()
   AND g.receiving_epoch=g.original_epoch+1 AND p.write_state='active' AND p.moved_to IS NULL
   AND n.purpose=CASE f.kind WHEN 'applied' THEN 'identity-public-output-applied' ELSE 'identity-public-output-cancelled' END
   AND o.type='com.rezics.semantic.public-output.capture.v1')
 THEN RAISE EXCEPTION 'public_output_gate_requires_native_fence'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER identity_public_output_gate_closed AFTER UPDATE ON semantic.identity_public_output_gate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_gate_close();

-- Project only the immutable address, not the up-to-2 MiB definition, in this hot trigger.
CREATE OR REPLACE FUNCTION semantic.guard_public_output_fresh_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; p semantic.identity_public_output_progress;
BEGIN
 SELECT partition_no,capture_id,scope_key,hold_id INTO STRICT a FROM semantic.identity_public_output_accepted
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

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Public output staged custody is forward only'; END $$;
