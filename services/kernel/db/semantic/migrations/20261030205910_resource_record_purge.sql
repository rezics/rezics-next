-- migrate:up
-- Source-owned ordinary resource provenance and bounded retained custody progress.
ALTER TABLE semantic.context ADD COLUMN deletion_generation uuid;
ALTER TABLE semantic.context ADD COLUMN deletion_transaction_id uuid;
CREATE TABLE semantic.resource_record_purge_commit (
 route integer NOT NULL, kind text NOT NULL CHECK(kind IN ('context','zone')), resource_id uuid NOT NULL,
 deletion_generation uuid NOT NULL, transaction_id uuid NOT NULL, epoch integer NOT NULL, position bigint NOT NULL,
 source_version bigint NOT NULL, deleted_at timestamptz NOT NULL, purge_after timestamptz NOT NULL,
 PRIMARY KEY(route,kind,resource_id,deletion_generation), CHECK(purge_after=deleted_at+interval '720 hours')
);
CREATE TRIGGER resource_record_purge_commit_immutable BEFORE UPDATE OR DELETE ON semantic.resource_record_purge_commit
 FOR EACH ROW EXECUTE FUNCTION semantic.protect_record_retention_commit();
CREATE TABLE semantic.record_purge_writer (
 partition_no integer NOT NULL, source_key text NOT NULL, route integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('context','zone')), resource_id uuid NOT NULL,
 enrolled boolean NOT NULL, birth_transaction uuid NOT NULL,
 frontier bigint NOT NULL DEFAULT 0, sealed_cut uuid, sealed_generation uuid, sealed_version text, sealed_epoch integer,
 PRIMARY KEY(partition_no,source_key), UNIQUE(route,kind,resource_id), CHECK(partition_no=route/16)
);
CREATE TABLE semantic.record_purge_command (
 partition_no integer NOT NULL, source_key text NOT NULL, key bigint GENERATED ALWAYS AS IDENTITY,
 transaction_id uuid NOT NULL, epoch integer, position bigint,
 PRIMARY KEY(partition_no,source_key,key), UNIQUE(partition_no,source_key,transaction_id),
 FOREIGN KEY(partition_no,source_key) REFERENCES semantic.record_purge_writer(partition_no,source_key)
);
CREATE TABLE semantic.record_purge_hold (
 partition_no integer NOT NULL, source_key text NOT NULL, deletion_generation uuid NOT NULL,
 receiving_partition integer NOT NULL CHECK(receiving_partition BETWEEN 0 AND 4095), receiving_id uuid NOT NULL,
 hold_id uuid NOT NULL UNIQUE, route integer NOT NULL, kind text NOT NULL,
 owner_id uuid NOT NULL, record_id uuid NOT NULL, source_epoch integer NOT NULL,
 source jsonb NOT NULL, transaction_id uuid NOT NULL, released boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,source_key,deletion_generation,receiving_partition,receiving_id),
 CHECK(partition_no=route/16), CHECK(kind IN ('contribution','context','zone'))
);
CREATE INDEX record_purge_hold_gate ON semantic.record_purge_hold(route,kind,owner_id,record_id) WHERE NOT released;
CREATE TABLE semantic.record_purge_receiving (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095), receiving_id uuid NOT NULL,
 source_key text NOT NULL, deletion_generation uuid NOT NULL, hold_id uuid NOT NULL,
 source_partition integer NOT NULL, source_epoch integer NOT NULL, receiver_epoch integer NOT NULL,
 source jsonb NOT NULL, source_transaction_id uuid NOT NULL, accepted_transaction_id uuid NOT NULL,
 completion_transaction_id uuid, completion_position bigint,
 PRIMARY KEY(partition_no,receiving_id,source_key,deletion_generation), UNIQUE(partition_no,hold_id),
 CHECK(completion_position IS NULL OR completion_transaction_id IS NOT NULL)
);
CREATE FUNCTION semantic.resource_record_purge_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='deleted' AND OLD.state='active' THEN NEW.deletion_generation:=gen_random_uuid(); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER context_record_purge_generation BEFORE UPDATE ON semantic.context
 FOR EACH ROW EXECUTE FUNCTION semantic.resource_record_purge_generation();
CREATE FUNCTION semantic.resource_record_purge_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE id uuid; generation uuid; v_transaction uuid; version bigint; due timestamptz;
BEGIN
 IF NOT (NEW.state='deleted' AND OLD.state='active') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='context' THEN
  id:=NEW.context_id;v_transaction:=NEW.deletion_transaction_id;version:=NEW.security_revision;due:=NEW.purge_after;
 ELSE
  id:=NEW.zone_id;v_transaction:=NEW.transaction_id;version:=NEW.revision;due:=NEW.restore_until;
 END IF;
 INSERT INTO semantic.resource_record_purge_commit
 (route,kind,resource_id,deletion_generation,transaction_id,epoch,position,source_version,deleted_at,purge_after)
 SELECT NEW.route,TG_TABLE_NAME,id,NEW.deletion_generation,v_transaction,b.epoch,b.position,version,NEW.deleted_at,due
 FROM editorial.write_basis b WHERE b.partition_no=NEW.route/16 AND b.transaction_id=v_transaction
 AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource_deletion_requires_same_native_commit'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_record_purge_commit AFTER UPDATE ON semantic.context
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.resource_record_purge_commit();
CREATE FUNCTION semantic.record_purge_command_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE semantic.record_purge_command c SET epoch=b.epoch,position=b.position FROM editorial.write_basis b
 WHERE c.partition_no=NEW.partition_no AND c.source_key=NEW.source_key AND c.key=NEW.key
 AND b.partition_no=c.partition_no AND b.transaction_id=c.transaction_id AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN
  UPDATE semantic.record_purge_command c SET epoch=r.epoch,position=r.position FROM core.receipt r
  WHERE c.partition_no=NEW.partition_no AND c.source_key=NEW.source_key AND c.key=NEW.key
  AND r.partition_no=c.partition_no AND r.transaction_id=c.transaction_id AND r.xmin=pg_current_xact_id()::xid;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_source_requires_same_native_commit'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER record_purge_command_commit AFTER INSERT ON semantic.record_purge_command
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_command_commit();
-- Every native eligibility writer shares this durable gate, including legal hold and takedown writers.
CREATE FUNCTION semantic.record_purge_source_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; v_kind text; v_owner uuid; id uuid; item jsonb;
BEGIN
 item:=CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
 r:=(item->>'route')::integer;
 IF TG_TABLE_NAME IN ('context','context_extension','context_extension_activation') THEN v_kind:='context';v_owner:=(item->>'context_id')::uuid;id:=v_owner;
 ELSIF TG_TABLE_NAME='zone' THEN v_kind:='zone';v_owner:=(item->>'zone_id')::uuid;id:=v_owner;
 ELSE v_kind:='contribution';v_owner:=(item->>'subject_id')::uuid;id:=(item->>'candidate_id')::uuid;
 END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME IN ('context_extension','context_extension_activation') THEN
  PERFORM 1 FROM semantic.context WHERE route=r AND context_id=v_owner FOR UPDATE;
  IF EXISTS(SELECT 1 FROM semantic.record_purge_writer WHERE route=r AND kind='context'
    AND resource_id=v_owner AND sealed_cut IS NOT NULL) THEN RAISE EXCEPTION 'record_purge_source_inventory_sealed'; END IF;
 ELSIF TG_TABLE_NAME='hidden_candidate' THEN
  PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=v_owner FOR UPDATE;
  PERFORM 1 FROM semantic.record_lifecycle WHERE route=r AND subject_id=v_owner AND candidate_id=id FOR UPDATE;
 END IF;
 IF EXISTS(SELECT 1 FROM semantic.record_purge_hold h WHERE h.route=r AND h.kind=v_kind
   AND h.owner_id=v_owner AND (id IS NULL OR h.record_id=id) AND NOT h.released LIMIT 1) THEN
  RAISE EXCEPTION 'record_purge_receiving_hold_outstanding' USING ERRCODE='55P03';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER context_record_purge_gate BEFORE UPDATE OR DELETE ON semantic.context
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
CREATE TRIGGER contribution_record_purge_gate BEFORE UPDATE OR DELETE ON semantic.record_lifecycle
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
CREATE TRIGGER candidate_record_purge_gate BEFORE UPDATE OR DELETE ON semantic.candidate
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
CREATE TRIGGER subject_record_purge_gate BEFORE UPDATE OR DELETE ON semantic.subject
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
CREATE TRIGGER hidden_record_purge_gate BEFORE INSERT OR UPDATE OR DELETE ON semantic.hidden_candidate
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
-- Neither a cloned handle nor editable metadata can change a retained accepted binding.
CREATE FUNCTION semantic.record_purge_hold_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'released') IS DISTINCT FROM (to_jsonb(OLD)-'released')
    OR (OLD.released AND NOT NEW.released) THEN RAISE EXCEPTION 'record_purge_hold_is_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_purge_hold_immutable BEFORE UPDATE OR DELETE ON semantic.record_purge_hold
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_hold_immutable();
CREATE FUNCTION semantic.record_purge_receiving_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR
   (to_jsonb(NEW)-'completion_transaction_id'-'completion_position') IS DISTINCT FROM
   (to_jsonb(OLD)-'completion_transaction_id'-'completion_position') OR
   (OLD.completion_transaction_id IS NOT NULL AND NEW.completion_transaction_id IS DISTINCT FROM OLD.completion_transaction_id) OR
   (OLD.completion_position IS NOT NULL AND NEW.completion_position IS DISTINCT FROM OLD.completion_position)
 THEN RAISE EXCEPTION 'record_purge_receiving_is_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_purge_receiving_immutable BEFORE UPDATE OR DELETE ON semantic.record_purge_receiving
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_receiving_immutable();
CREATE FUNCTION semantic.record_purge_receiving_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.completion_transaction_id IS NOT NULL OR NEW.completion_transaction_id IS NULL THEN RETURN NEW; END IF;
 UPDATE semantic.record_purge_receiving r SET completion_position=b.position FROM editorial.write_basis b
 WHERE r.partition_no=NEW.partition_no AND r.hold_id=NEW.hold_id
 AND b.partition_no=r.partition_no AND b.transaction_id=r.completion_transaction_id AND b.epoch=r.receiver_epoch
 AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'record_purge_completion_requires_same_native_command'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER record_purge_receiving_completion AFTER UPDATE ON semantic.record_purge_receiving
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_receiving_completion();

-- Unknown earlier writers permanently leave the precise source scope unsealed. Current native
-- writers must acquire the source gate and enroll before creating a command's original copies.
CREATE FUNCTION semantic.record_purge_resource_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_kind text; v_transaction uuid;
BEGIN
 IF TG_TABLE_NAME='zone' THEN v_id:=NEW.zone_id;v_kind:='zone';v_transaction:=NEW.transaction_id;
 ELSE v_id:=NEW.context_id;v_kind:='context';
  v_transaction:=NEW.recorded_transaction_id;
  IF TG_TABLE_NAME='context' THEN
   IF TG_OP='UPDATE' AND NEW.state='deleted' AND OLD.state='active' THEN
    v_transaction:=NEW.deletion_transaction_id;
   END IF;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=NEW.route/16
   AND b.transaction_id=v_transaction AND b.xmin=pg_current_xact_id()::xid) AND NOT EXISTS (
   SELECT 1 FROM semantic.record_purge_command c JOIN semantic.record_purge_writer w USING(partition_no,source_key)
   WHERE w.route=NEW.route AND w.kind=v_kind AND w.resource_id=v_id AND c.transaction_id=v_transaction
 ) THEN
  UPDATE semantic.record_purge_writer SET enrolled=false,sealed_cut=NULL
   WHERE route=NEW.route AND kind=v_kind AND resource_id=v_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_record_purge_writer AFTER INSERT OR UPDATE ON semantic.context
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();
CREATE CONSTRAINT TRIGGER context_extension_record_purge_writer AFTER INSERT OR UPDATE ON semantic.context_extension
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();
CREATE CONSTRAINT TRIGGER context_activation_record_purge_writer AFTER INSERT OR UPDATE ON semantic.context_extension_activation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();
CREATE TRIGGER context_extension_record_purge_gate BEFORE INSERT OR UPDATE OR DELETE ON semantic.context_extension
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
CREATE TRIGGER context_activation_record_purge_gate BEFORE INSERT OR UPDATE OR DELETE ON semantic.context_extension_activation
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();

-- Source-owned partition fence: a released-home hold pins its source incarnation until
-- verified receiving completion. Ordinary command position fences do not touch these columns.
CREATE INDEX record_purge_hold_source_home ON semantic.record_purge_hold(partition_no) WHERE NOT released;
CREATE FUNCTION semantic.record_purge_source_home_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.epoch,NEW.write_state,NEW.moved_to) IS DISTINCT FROM (OLD.epoch,OLD.write_state,OLD.moved_to)
 AND EXISTS(SELECT 1 FROM semantic.record_purge_hold h WHERE h.partition_no=OLD.partition_no AND NOT h.released LIMIT 1)
 THEN RAISE EXCEPTION 'record_purge_source_home_hold_outstanding' USING ERRCODE='55P03'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_purge_source_home_gate BEFORE UPDATE OF epoch,write_state,moved_to ON core.partition
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_home_gate();

-- migrate:down
-- Retained custody must be resolved before removing this schema.
