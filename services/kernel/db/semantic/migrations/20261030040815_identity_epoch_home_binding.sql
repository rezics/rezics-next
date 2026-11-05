-- migrate:up
-- Retain all native records while making each authority key start at its actual home.
ALTER TABLE semantic.identity_epoch_ack DROP CONSTRAINT identity_epoch_ack_job_id_fkey;
ALTER TABLE semantic.identity_epoch_admission_plan DROP CONSTRAINT identity_epoch_admission_plan_job_id_fkey;
ALTER TABLE semantic.identity_epoch_admission_source DROP CONSTRAINT identity_epoch_admission_source_job_id_fkey;
ALTER TABLE semantic.identity_epoch_change DROP CONSTRAINT identity_epoch_change_job_id_fkey;
ALTER TABLE semantic.identity_epoch_effect_receipt DROP CONSTRAINT identity_epoch_effect_receipt_job_id_fkey;
ALTER TABLE semantic.identity_epoch_input DROP CONSTRAINT identity_epoch_input_job_id_fkey;
ALTER TABLE semantic.identity_epoch_bootstrap_topology_home ADD COLUMN partition_no integer NOT NULL DEFAULT 0 CHECK(partition_no=0);
ALTER TABLE semantic.identity_epoch_bootstrap_topology_home ALTER COLUMN partition_no DROP DEFAULT;
ALTER TABLE semantic.identity_epoch_topology_custody ADD COLUMN partition_no integer NOT NULL DEFAULT 0 CHECK(partition_no=0);
ALTER TABLE semantic.identity_epoch_topology_custody ALTER COLUMN partition_no DROP DEFAULT;
ALTER TABLE semantic.identity_epoch_ack DROP CONSTRAINT identity_epoch_ack_pkey;
ALTER TABLE semantic.identity_epoch_ack ADD PRIMARY KEY(partition_no,job_id,step);
ALTER TABLE semantic.identity_epoch_admission_plan DROP CONSTRAINT identity_epoch_admission_plan_pkey;
ALTER TABLE semantic.identity_epoch_admission_plan ADD PRIMARY KEY(partition_no,job_id,resource_home);
ALTER TABLE semantic.identity_epoch_admission_source DROP CONSTRAINT identity_epoch_admission_source_pkey;
ALTER TABLE semantic.identity_epoch_admission_source ADD PRIMARY KEY(partition_no,job_id,original);
ALTER TABLE semantic.identity_epoch_change DROP CONSTRAINT identity_epoch_change_pkey;
ALTER TABLE semantic.identity_epoch_change ADD PRIMARY KEY(partition_no,job_id,original);
ALTER TABLE semantic.identity_epoch_effect_receipt DROP CONSTRAINT identity_epoch_effect_receipt_pkey;
ALTER TABLE semantic.identity_epoch_effect_receipt ADD PRIMARY KEY(partition_no,job_id,step,effect_key);
ALTER TABLE semantic.identity_epoch_group DROP CONSTRAINT identity_epoch_group_pkey;
ALTER TABLE semantic.identity_epoch_group ADD PRIMARY KEY(partition_no,terminal);
ALTER TABLE semantic.identity_epoch_input DROP CONSTRAINT identity_epoch_input_pkey;
ALTER TABLE semantic.identity_epoch_input ADD PRIMARY KEY(partition_no,job_id,terminal);
ALTER TABLE semantic.identity_epoch_job DROP CONSTRAINT identity_epoch_job_pkey;
ALTER TABLE semantic.identity_epoch_job ADD PRIMARY KEY(partition_no,job_id);
ALTER TABLE semantic.identity_epoch_legacy_member DROP CONSTRAINT identity_epoch_legacy_member_pkey;
ALTER TABLE semantic.identity_epoch_legacy_member ADD PRIMARY KEY(partition_no,terminal,original);
ALTER TABLE semantic.identity_epoch_original DROP CONSTRAINT identity_epoch_original_pkey;
ALTER TABLE semantic.identity_epoch_original ADD PRIMARY KEY(partition_no,generation,original);
ALTER TABLE semantic.identity_epoch_bootstrap_topology_home DROP CONSTRAINT identity_epoch_bootstrap_topology_home_pkey;
ALTER TABLE semantic.identity_epoch_bootstrap_topology_home ADD PRIMARY KEY(partition_no,source_partition);
ALTER TABLE semantic.identity_epoch_topology_custody DROP CONSTRAINT identity_epoch_topology_custody_pkey;
ALTER TABLE semantic.identity_epoch_topology_custody ADD PRIMARY KEY(partition_no,source_partition);
ALTER TABLE semantic.identity_epoch_job DROP CONSTRAINT identity_epoch_job_receipt_key_key;
CREATE INDEX identity_epoch_job_receipt ON semantic.identity_epoch_job(partition_no,receipt_key);
ALTER TABLE semantic.identity_epoch_ack ADD FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id);
ALTER TABLE semantic.identity_epoch_admission_plan ADD FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id);
ALTER TABLE semantic.identity_epoch_admission_source ADD FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id);
ALTER TABLE semantic.identity_epoch_change ADD FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id);
ALTER TABLE semantic.identity_epoch_effect_receipt ADD FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id);
ALTER TABLE semantic.identity_epoch_input ADD FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id);
DROP INDEX semantic.identity_epoch_generation_original;
DROP INDEX semantic.identity_epoch_scoped_generation_original;
CREATE INDEX identity_epoch_scoped_generation_original ON semantic.identity_epoch_original(partition_no,generation,terminal,original) WHERE present;
CREATE TABLE semantic.identity_epoch_bootstrap_basis (
 partition_no integer NOT NULL, source_partition integer NOT NULL, source_generation bigint NOT NULL,
 source_transaction_id uuid NOT NULL, transaction_id uuid NOT NULL, native_epoch integer NOT NULL,
 native_position bigint NOT NULL,
 PRIMARY KEY(partition_no,source_partition,source_generation),
 FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position)
);
CREATE TRIGGER identity_epoch_bootstrap_basis_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_bootstrap_basis
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


-- Receipt identities are unchanged. Custody lives at the actual actor/account route.
CREATE TABLE semantic.identity_epoch_receipt_binding (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), receipt_key text NOT NULL,
 account_id uuid NOT NULL, intent_digest text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
 state text NOT NULL CHECK(state IN ('pending','accepted','not-applied')),
 accepted_job uuid, accepted_epoch bigint,
 PRIMARY KEY(partition_no,receipt_key),
 CHECK((accepted_job IS NULL)=(accepted_epoch IS NULL)),
 CHECK((state='accepted')=(accepted_job IS NOT NULL))
);
CREATE INDEX identity_epoch_receipt_account ON semantic.identity_epoch_receipt_binding(partition_no,account_id,receipt_key);
CREATE TABLE semantic.identity_epoch_receipt_claim (
 partition_no integer NOT NULL, receipt_key text NOT NULL, generation bigint NOT NULL,
 intent_digest text NOT NULL, receipt jsonb NOT NULL, intent jsonb NOT NULL,
 job_id uuid NOT NULL,job_home integer NOT NULL,job_epoch bigint NOT NULL,scope_digest text NOT NULL,
 sources jsonb NOT NULL,transaction_id uuid NOT NULL,imported boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,receipt_key,generation),
 FOREIGN KEY(partition_no,receipt_key) REFERENCES semantic.identity_epoch_receipt_binding(partition_no,receipt_key)
);
CREATE TABLE semantic.identity_epoch_receipt_claim_commit (
 partition_no integer NOT NULL,receipt_key text NOT NULL,generation bigint NOT NULL,transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,receipt_key,generation),
 FOREIGN KEY(partition_no,receipt_key,generation) REFERENCES semantic.identity_epoch_receipt_claim(partition_no,receipt_key,generation),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TABLE semantic.identity_epoch_receipt_closure (
 partition_no integer NOT NULL,receipt_key text NOT NULL,generation bigint NOT NULL,resource_home integer NOT NULL,
 transaction_id uuid NOT NULL,native_epoch integer NOT NULL,native_position bigint NOT NULL,
 PRIMARY KEY(partition_no,receipt_key,generation,resource_home),
 FOREIGN KEY(partition_no,receipt_key,generation) REFERENCES semantic.identity_epoch_receipt_claim(partition_no,receipt_key,generation)
);
CREATE FUNCTION semantic.keep_identity_epoch_accepted_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='accepted' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF (OLD.partition_no,OLD.receipt_key,OLD.account_id,OLD.intent_digest) IS DISTINCT FROM
    (NEW.partition_no,NEW.receipt_key,NEW.account_id,NEW.intent_digest) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_epoch_receipt_binding_stable BEFORE UPDATE ON semantic.identity_epoch_receipt_binding
 FOR EACH ROW EXECUTE FUNCTION semantic.keep_identity_epoch_accepted_binding();
CREATE TRIGGER identity_epoch_receipt_claim_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receipt_claim
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_receipt_claim_commit_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receipt_claim_commit
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_receipt_closure_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receipt_closure
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
-- Migration custody preserves old job/native transaction identities; a released bind confirms the
-- original job at its home before creating the first native actor-home confirmation.
CREATE FUNCTION semantic.identity_epoch_migration_json(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE jsonb_typeof(v)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||semantic.identity_epoch_migration_json(value),',' ORDER BY key COLLATE "C") FROM jsonb_each(v)),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(semantic.identity_epoch_migration_json(value),',' ORDER BY n) FROM jsonb_array_elements(v) WITH ORDINALITY a(value,n)),'')||']'
 ELSE v::text END;
$$;
WITH old AS (
 SELECT j.*,CASE WHEN receipt->>'kind'='subject.merge' THEN (receipt->'command'->>'actorAccountId')::uuid ELSE (receipt->>'account')::uuid END account_id,
 encode(sha256(convert_to(semantic.identity_epoch_migration_json(jsonb_build_array(intent,receipt)),'UTF8')),'hex') intent_digest
 FROM semantic.identity_epoch_job j
)
INSERT INTO semantic.identity_epoch_receipt_binding
 SELECT (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))/16,
 receipt_key,account_id,intent_digest,1,'accepted',job_id,epoch FROM old;
INSERT INTO semantic.identity_epoch_receipt_claim
 SELECT b.partition_no,b.receipt_key,1,b.intent_digest,j.receipt,j.intent,j.job_id,j.partition_no,j.epoch,j.scope_digest,
 coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM semantic.identity_epoch_admission_source s WHERE s.partition_no=j.partition_no AND s.job_id=j.job_id),'[]'::jsonb),
 j.recorded_transaction_id,true
 FROM semantic.identity_epoch_receipt_binding b JOIN semantic.identity_epoch_job j ON j.receipt_key=b.receipt_key;
DROP FUNCTION semantic.identity_epoch_migration_json(jsonb);

-- The retained receiving input is actual local custody, separately delivered after source release.
CREATE TABLE semantic.identity_epoch_admission_handoff (
 partition_no integer NOT NULL,job_id uuid NOT NULL,job_epoch bigint NOT NULL,scope_digest text NOT NULL,
 job_home integer NOT NULL,source_transaction_id uuid NOT NULL,inputs jsonb NOT NULL,
 PRIMARY KEY(partition_no,job_id)
);
CREATE TRIGGER identity_epoch_admission_handoff_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_admission_handoff
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE OR REPLACE FUNCTION semantic.acquire_identity_epoch_admission(p_home integer,p_job uuid,p_epoch bigint,p_scope text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_epoch_admission_attempt;c semantic.identity_epoch_control;h semantic.identity_epoch_admission_handoff;
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
 PERFORM 1 FROM semantic.identity_epoch_group g
 JOIN jsonb_to_recordset(h.inputs) i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
 ON g.partition_no=p_home AND g.terminal=i.terminal ORDER BY g.terminal FOR UPDATE OF g;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_group g
 JOIN jsonb_to_recordset(h.inputs) i(terminal uuid) ON g.partition_no=p_home AND g.terminal=i.terminal
 WHERE g.pending_job IS NOT NULL AND g.pending_job<>p_job) THEN RAISE EXCEPTION 'identity_epoch_busy'; END IF;
 IF c.pending_job IS NOT NULL AND c.pending_job<>p_job THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(h.inputs) i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
 LEFT JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal,g.generation,g.version,g.owner_epoch)=
 (p_home,i.terminal,i.generation,i.basis_version,i.owner_epoch)
 LEFT JOIN core.partition o ON o.partition_no=p_home AND o.epoch=i.owner_epoch AND o.write_state='active'
 WHERE g.terminal IS NULL OR o.partition_no IS NULL) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 INSERT INTO semantic.identity_epoch_admission_attempt VALUES(p_home,p_job,p_epoch,p_scope,'acquired');
 UPDATE semantic.identity_epoch_group SET pending_job=p_job,pending_epoch=p_epoch WHERE partition_no=p_home
 AND terminal IN (SELECT i.terminal FROM jsonb_to_recordset(h.inputs) i(terminal uuid));
 UPDATE semantic.identity_epoch_control SET pending_job=p_job,pending_epoch=p_epoch,allocated_epoch=greatest(allocated_epoch,p_epoch) WHERE partition_no=p_home;
END; $$;
-- Final source holds serialize with the same source dirty head used by native structural capture.
CREATE TABLE semantic.identity_epoch_admission_source_hold (
 partition_no integer NOT NULL,job_id uuid NOT NULL,job_epoch bigint NOT NULL,original uuid NOT NULL,route integer NOT NULL,
 scope_digest text NOT NULL,basis jsonb NOT NULL,transaction_id uuid NOT NULL,closed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,job_id,original),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE INDEX identity_epoch_source_hold_key ON semantic.identity_epoch_admission_source_hold(partition_no,route,original) WHERE NOT closed;
CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_key(r integer,id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- All structural writers already use this native trigger. Locking the dirty key orders a
 -- final source hold against an in-flight writer, including a writer predating the hold.
 PERFORM 1 FROM semantic.identity_epoch_dirty WHERE route=r AND original=id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold WHERE partition_no=r/16 AND route=r AND original=id AND NOT closed)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=r/16;
 INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES(r,id)
 ON CONFLICT(route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
 UPDATE semantic.identity_epoch_group SET ready=false,version=version+1 WHERE partition_no=r/16 AND terminal=id AND pending_job IS NULL;
END; $$;

CREATE TABLE semantic.identity_epoch_admission_validation (
 partition_no integer NOT NULL,job_id uuid NOT NULL,original uuid NOT NULL,source_home integer NOT NULL,
 transaction_id uuid NOT NULL,native_epoch integer NOT NULL,native_position bigint NOT NULL,
 PRIMARY KEY(partition_no,job_id,original),
 FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id)
);
CREATE TRIGGER identity_epoch_admission_validation_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_admission_validation
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- migrate:down
-- Forward only: native custody and immutable receipt history cannot be discarded.
