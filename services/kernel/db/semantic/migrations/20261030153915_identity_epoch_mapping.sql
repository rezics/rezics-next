-- migrate:up
CREATE TABLE semantic.identity_epoch_mapping_head (
 partition_no integer NOT NULL, job_id uuid NOT NULL, unit integer NOT NULL CHECK(unit>=0),
 frontier jsonb NOT NULL, change jsonb, payload jsonb, outputs jsonb NOT NULL, transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,job_id),
 FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id),
 CHECK(jsonb_array_length(frontier->'after')<=8 AND octet_length(frontier::text)<=2048),
 CHECK(jsonb_array_length(outputs)<=2), CHECK(octet_length(payload::text)<=4096)
);
CREATE TABLE semantic.identity_epoch_mapping_plan (
 partition_no integer NOT NULL,job_id uuid NOT NULL,unit integer NOT NULL,plan_digest text NOT NULL,home integer NOT NULL,
 PRIMARY KEY(partition_no,job_id,unit),
 FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id)
);
CREATE TABLE semantic.identity_epoch_mapping_effect (
 partition_no integer NOT NULL,job_id uuid NOT NULL,unit integer NOT NULL,job_epoch bigint NOT NULL,
 scope_digest text NOT NULL,plan_digest text NOT NULL,transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,job_id,unit),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE semantic.identity_epoch_mapping_payload (
 partition_no integer NOT NULL,job_id uuid NOT NULL,unit integer NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(partition_no,job_id,unit),
 FOREIGN KEY(partition_no,job_id,unit) REFERENCES semantic.identity_epoch_mapping_effect(partition_no,job_id,unit),
 CHECK(octet_length(result::text)<=4096)
);
CREATE TABLE semantic.identity_epoch_mapping_generation (
 partition_no integer NOT NULL,slot integer NOT NULL CHECK(slot BETWEEN 0 AND 3),
 job_id uuid,generation uuid NOT NULL,terminal uuid NOT NULL,
 PRIMARY KEY(partition_no,slot),UNIQUE(partition_no,generation)
);
CREATE TRIGGER identity_epoch_mapping_effect_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_mapping_effect
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_mapping_plan_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_mapping_plan
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE TABLE semantic.identity_epoch_mapping_fence (
 route integer NOT NULL,destination uuid NOT NULL,job_id uuid NOT NULL,job_epoch bigint NOT NULL,transaction_id uuid NOT NULL,
 PRIMARY KEY(route,destination),
 CHECK(route=get_byte(uuid_send(destination),10)*256+get_byte(uuid_send(destination),11)),
 FOREIGN KEY(route,destination) REFERENCES semantic.subject(route,subject_id)
);

-- Native effect rows precede the writes and share the executor's transaction. The
-- deferred native-commit FK prevents a plain SQL transaction from minting custody.
CREATE FUNCTION semantic.identity_epoch_mapping_owns(r integer,id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence f
 JOIN semantic.identity_epoch_mapping_effect e ON e.partition_no=r/16
   AND e.job_id=f.job_id AND e.job_epoch=f.job_epoch AND e.transaction_id=f.transaction_id
 WHERE f.route=r AND f.destination=id AND e.xmin::text=pg_current_xact_id()::text);
$$;
CREATE FUNCTION semantic.guard_identity_epoch_mapping_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; id uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD.route;id:=OLD.subject_id; ELSE r:=NEW.route;id:=NEW.subject_id; END IF;
 -- The subject lock orders a writer predating the fence with the first fence.
 PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence WHERE route=r AND destination=id)
   AND NOT semantic.identity_epoch_mapping_owns(r,id)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
CREATE TRIGGER identity_epoch_mapping_inbound_guard BEFORE INSERT OR UPDATE OR DELETE ON semantic.inbound_link
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_epoch_mapping_links();
CREATE TRIGGER identity_epoch_mapping_outbound_guard BEFORE INSERT OR UPDATE OR DELETE ON semantic.outbound_link
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_epoch_mapping_links();

CREATE OR REPLACE FUNCTION semantic.capture_identity_epoch_key(r integer,id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owned boolean;
BEGIN
 PERFORM 1 FROM semantic.identity_epoch_dirty WHERE route=r AND original=id FOR UPDATE;
 owned:=semantic.identity_epoch_mapping_owns(r,id);
 IF (EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold
       WHERE partition_no=r/16 AND route=r AND original=id AND NOT closed)
     OR EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence WHERE route=r AND destination=id)) AND NOT owned
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES(r,id)
 ON CONFLICT(route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
 IF owned THEN
   -- These writes are already described by the immutable page intent. They do
   -- not create an uncaptured legacy source change or invalidate its bootstrap.
   UPDATE semantic.identity_epoch_dirty SET captured_revision=revision WHERE route=r AND original=id;
   RETURN;
 END IF;
 UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,
   sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=r/16;
 UPDATE semantic.identity_epoch_group SET ready=false,version=version+1
   WHERE partition_no=r/16 AND terminal=id AND pending_job IS NULL;
END; $$;

CREATE FUNCTION semantic.apply_identity_epoch_mapping_source(r integer,id uuid,previous uuid,destination uuid,release_digest text,tid uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE m semantic.identity_epoch_mapping;s semantic.subject;revision_no integer;sequence_no integer;actual uuid;
BEGIN
 IF r<>get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11)
   OR NOT semantic.identity_epoch_mapping_owns(r,id)
   OR NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence f WHERE f.route=r AND f.destination=id AND f.transaction_id=tid)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 SELECT * INTO STRICT m FROM semantic.identity_epoch_mapping WHERE route=r AND original=id FOR UPDATE;
 SELECT * INTO STRICT s FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 SELECT target,sequence INTO actual,sequence_no FROM semantic.redirect WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1;
 IF m.terminal<>previous OR (destination<>id AND coalesce(actual,id)<>previous)
   OR s.visibility<>'visible' OR EXISTS(SELECT 1 FROM semantic.account_agent_subject WHERE route=r AND subject_id=id)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF previous=destination THEN RETURN true; END IF;
 SELECT revision INTO STRICT revision_no FROM semantic.revision WHERE route=r AND subject_id=id ORDER BY revision DESC LIMIT 1;
 IF destination=id THEN
  DELETE FROM semantic.redirect WHERE route=r AND subject_id=id AND sequence=sequence_no;
  IF EXISTS(SELECT 1 FROM semantic.redirect WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1) THEN RETURN false; END IF;
 ELSE
  INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
    VALUES(r,id,coalesce(sequence_no,0)+1,destination,tid);
 END IF;
 INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
 VALUES(r,id,revision_no+1,'merge',release_digest,tid);
 UPDATE semantic.subject SET current_release=release_digest,projection_pending=true WHERE route=r AND subject_id=id;
 IF previous=id AND destination<>id THEN
  UPDATE semantic.partition_subjects SET visible=visible-1 WHERE partition_no=r/16;
 ELSIF previous<>id AND destination=id THEN
  UPDATE semantic.partition_subjects SET visible=visible+1 WHERE partition_no=r/16;
 END IF;
 RETURN true;
END; $$;
DROP INDEX semantic.identity_epoch_current_original;
CREATE INDEX identity_epoch_current_original ON semantic.identity_epoch_original(partition_no,original) WHERE present;
INSERT INTO semantic.identity_epoch_mapping_generation(partition_no,slot,generation,terminal)
SELECT partition_no,(row_number() OVER(PARTITION BY partition_no ORDER BY generation)-1)::integer,generation,terminal
FROM (SELECT DISTINCT o.partition_no,o.generation,o.terminal FROM semantic.identity_epoch_original o
 WHERE NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_group g
   WHERE (g.partition_no,g.terminal,g.generation)=(o.partition_no,o.terminal,o.generation))) retained;

CREATE OR REPLACE FUNCTION semantic.acquire_identity_epoch_admission(p_home integer, p_job uuid, p_epoch bigint, p_scope text) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_generation WHERE partition_no=p_home AND job_id IS DISTINCT FROM p_job LIMIT 1) THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 INSERT INTO semantic.identity_epoch_admission_attempt VALUES(p_home,p_job,p_epoch,p_scope,'acquired');
 UPDATE semantic.identity_epoch_group SET pending_job=p_job,pending_epoch=p_epoch WHERE partition_no=p_home
 AND terminal IN (SELECT i.terminal FROM jsonb_to_recordset(h.inputs) i(terminal uuid));
 UPDATE semantic.identity_epoch_control SET pending_job=p_job,pending_epoch=p_epoch,allocated_epoch=greatest(allocated_epoch,p_epoch) WHERE partition_no=p_home;
END; $$;

-- migrate:down
-- Forward-only native mapping custody; live immutable input generations cannot be discarded.
