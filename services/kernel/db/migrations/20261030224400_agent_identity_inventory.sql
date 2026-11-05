-- migrate:up
-- Only newly converted ORIGINAL native writers enroll. Historical rows are deliberately untouched.
CREATE TABLE core.agent_identity_inventory (
 partition_no integer NOT NULL REFERENCES core.partition(partition_no),
 source_route integer NOT NULL, source_account_id uuid NOT NULL,
 source_direction text COLLATE "C" NOT NULL, source_receipt_id uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 source_epoch integer NOT NULL CHECK(source_epoch>0), source_position bigint NOT NULL CHECK(source_position>0),
 source_transaction_id uuid NOT NULL,
 producer_version integer NOT NULL CHECK(producer_version=1),
 conversion_coverage text NOT NULL CHECK(conversion_coverage='native-receipt-outbox/v1'),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 receiver_epoch integer NOT NULL CHECK(receiver_epoch>0), domain_generation bigint NOT NULL CHECK(domain_generation>0),
 native_writer_state text NOT NULL DEFAULT 'closed' CHECK(native_writer_state='closed'),
 native_command_kind text NOT NULL, native_principal_kind text NOT NULL CHECK(native_principal_kind='account'),
 native_principal_id uuid NOT NULL, native_receipt_key text NOT NULL,
 state text NOT NULL DEFAULT 'declared' CHECK(state IN ('declared','sealed')),
 expected_locators bytea[], expected_event_types text[],
 PRIMARY KEY(partition_no,source_route,source_account_id,source_direction,source_receipt_id),
 FOREIGN KEY(source_route,source_account_id,source_direction,source_receipt_id)
   REFERENCES access.agent_identity_intent(route,account_id,direction,receipt_id),
 CHECK(partition_no=source_route/16),
 CHECK((state='declared' AND expected_locators IS NULL AND expected_event_types IS NULL) OR
       (state='sealed' AND cardinality(expected_locators) BETWEEN 2 AND 3 AND
        cardinality(expected_event_types)=cardinality(expected_locators)-1))
);
CREATE TABLE core.agent_identity_sdk_obligation (
 partition_no integer NOT NULL, source_route integer NOT NULL, source_account_id uuid NOT NULL,
 source_direction text COLLATE "C" NOT NULL, source_receipt_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 workflow_id text NOT NULL, delivery_key text NOT NULL,
 handoff_partition integer NOT NULL CHECK(handoff_partition BETWEEN 0 AND 4095),
 handoff_epoch integer NOT NULL CHECK(handoff_epoch>0), handoff_position bigint NOT NULL CHECK(handoff_position>0),
 handoff_transaction_id uuid NOT NULL, handoff_event_type text NOT NULL,
 -- These are real outstanding duties, not invented SDK coordinates or an absence certificate.
 future_writer_state text NOT NULL DEFAULT 'pending-recording-port' CHECK(future_writer_state='pending-recording-port'),
 PRIMARY KEY(partition_no,source_route,source_account_id,source_direction,source_receipt_id),
 FOREIGN KEY(partition_no,source_route,source_account_id,source_direction,source_receipt_id)
   REFERENCES core.agent_identity_inventory(partition_no,source_route,source_account_id,source_direction,source_receipt_id)
);

CREATE FUNCTION core.agent_identity_inventory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s access.agent_identity_intent;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original identity inventory requires owner discharge' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO s FROM access.agent_identity_intent WHERE route=NEW.source_route AND account_id=NEW.source_account_id
     AND direction=NEW.source_direction AND receipt_id=NEW.source_receipt_id AND xmin::text=pg_current_xact_id()::text FOR SHARE;
   IF NOT FOUND OR NEW.state<>'declared' OR NEW.generation<>1 OR
     (NEW.partition_no,NEW.source_digest,NEW.source_epoch,NEW.source_position,NEW.source_transaction_id,
      NEW.native_command_kind,NEW.native_principal_id,NEW.native_receipt_key) IS DISTINCT FROM
     (s.source_partition,s.intent_digest,s.source_epoch,s.source_position,s.source_transaction_id,
      s.native_command_kind,s.requested_by,s.native_receipt_key) THEN
     RAISE EXCEPTION 'Inventory requires its original native source writer' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 -- The serializer closes once, in the original creation transaction. Late hooks cannot reopen it.
 PERFORM 1 FROM core.agent_identity_inventory WHERE partition_no=OLD.partition_no AND source_route=OLD.source_route
   AND source_account_id=OLD.source_account_id AND source_direction=OLD.source_direction AND source_receipt_id=OLD.source_receipt_id
   AND xmin::text=pg_current_xact_id()::text;
 IF OLD.state='declared' AND NEW.state='sealed' AND FOUND AND
   (to_jsonb(NEW)-ARRAY['state','expected_locators','expected_event_types'])=
   (to_jsonb(OLD)-ARRAY['state','expected_locators','expected_event_types']) THEN RETURN NEW; END IF;
 -- A real later SDK enrollment must serialize with the SAME inventory lock and invalidate the cut.
 IF pg_trigger_depth()>1 AND NEW.generation=OLD.generation+1 AND
   (to_jsonb(NEW)-'generation')=(to_jsonb(OLD)-'generation') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Original identity inventory is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER agent_identity_inventory_guard BEFORE INSERT OR UPDATE OR DELETE ON core.agent_identity_inventory
 FOR EACH ROW EXECUTE FUNCTION core.agent_identity_inventory_guard();

CREATE FUNCTION core.agent_identity_sdk_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i core.agent_identity_inventory; s access.agent_identity_intent;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SDK obligation requires real receiving discharge' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT i FROM core.agent_identity_inventory WHERE partition_no=NEW.partition_no AND source_route=NEW.source_route
   AND source_account_id=NEW.source_account_id AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id
   FOR UPDATE;
 IF TG_OP='INSERT' THEN
   SELECT * INTO STRICT s FROM access.agent_identity_intent WHERE route=i.source_route AND account_id=i.source_account_id
     AND direction=i.source_direction AND receipt_id=i.source_receipt_id AND xmin::text=pg_current_xact_id()::text;
   IF i.state<>'declared' OR NEW.generation<>i.generation OR NEW.workflow_id<>s.workflow_id OR NEW.delivery_key<>s.delivery_key OR
      (NEW.handoff_partition,NEW.handoff_epoch,NEW.handoff_position,NEW.handoff_transaction_id,NEW.handoff_event_type) IS DISTINCT FROM
      (CASE WHEN s.direction='account-agent.verify' THEN s.decision_route ELSE s.source_partition END,
       CASE WHEN s.direction='account-agent.verify' THEN s.decision_epoch ELSE s.source_epoch END,
       CASE WHEN s.direction='account-agent.verify' THEN s.decision_position ELSE s.source_position END,
       CASE WHEN s.direction='account-agent.verify' THEN s.decision_transaction_id ELSE s.source_transaction_id END,
       CASE WHEN s.direction='account-agent.verify' THEN 'com.rezics.access.agent-verification.approved.v1'
            ELSE 'com.rezics.access.agent-verification.reversing.v1' END) THEN
     RAISE EXCEPTION 'SDK obligation requires original receipt and known enqueue handoff' USING ERRCODE='23514';
   END IF;
 ELSE
   IF (to_jsonb(NEW)-'generation') IS DISTINCT FROM (to_jsonb(OLD)-'generation') OR NEW.generation<>OLD.generation+1 THEN
     RAISE EXCEPTION 'SDK obligation binding is immutable' USING ERRCODE='23514';
   END IF;
   UPDATE core.agent_identity_inventory SET generation=generation+1
     WHERE partition_no=NEW.partition_no AND source_route=NEW.source_route AND source_account_id=NEW.source_account_id
       AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_identity_sdk_obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON core.agent_identity_sdk_obligation
 FOR EACH ROW EXECUTE FUNCTION core.agent_identity_sdk_obligation_guard();

CREATE FUNCTION core.agent_identity_inventory_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i core.agent_identity_inventory;
BEGIN
 SELECT * INTO i FROM core.agent_identity_inventory WHERE partition_no=NEW.partition_no AND source_route=NEW.source_route
   AND source_account_id=NEW.source_account_id AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id
   AND xmin::text=pg_current_xact_id()::text FOR UPDATE;
 IF NOT FOUND OR i.state<>'declared' OR
   (NEW.source_digest,NEW.source_epoch,NEW.source_position,NEW.source_transaction_id,NEW.receiver_epoch,NEW.domain_generation)
   IS DISTINCT FROM (i.source_digest,i.source_epoch,i.source_position,i.source_transaction_id,i.receiver_epoch,i.domain_generation) THEN
   RAISE EXCEPTION 'Identity copy requires original unsealed producer transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_identity_inventory_copy_guard BEFORE INSERT ON core.agent_identity_history_copy
 FOR EACH ROW EXECUTE FUNCTION core.agent_identity_inventory_copy_guard();

-- This deferred validator runs on the final row, after every serializer hook and the physical fence.
-- Its finite expected slots are producer vocabulary, not a count/EOF or transaction-wide discovery.
CREATE FUNCTION core.validate_agent_identity_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i core.agent_identity_inventory; slot record; c core.agent_identity_history_copy; n integer;
 expected_types text[]; expected_receipt bytea; expected_event bytea; kind_id integer;
BEGIN
 SELECT * INTO STRICT i FROM core.agent_identity_inventory WHERE partition_no=NEW.partition_no AND source_route=NEW.source_route
   AND source_account_id=NEW.source_account_id AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id;
 IF TG_OP='UPDATE' AND OLD.state='sealed' THEN RETURN NEW; END IF;
 expected_types:=CASE WHEN i.native_command_kind='access.agent-verification.pending'
   THEN ARRAY['com.rezics.access.account-updated.v1'] ELSE
   ARRAY['com.rezics.access.agent-verification.reversing.v1','com.rezics.access.account-updated.v1'] END;
 kind_id:=CASE i.native_command_kind WHEN 'access.agent-verification.pending' THEN 3
   WHEN 'access.agent-verification.released' THEN 4 WHEN 'access.agent-verification.revoked' THEN 5
   WHEN 'access.agent-verification.deleted' THEN 6 ELSE NULL END;
 IF i.state<>'sealed' OR kind_id IS NULL OR i.expected_event_types IS DISTINCT FROM expected_types OR
   cardinality(i.expected_locators)<>cardinality(expected_types)+1 OR NOT EXISTS (
     SELECT 1 FROM core.agent_identity_sdk_obligation o WHERE o.partition_no=i.partition_no AND o.source_route=i.source_route
       AND o.source_account_id=i.source_account_id AND o.source_direction=i.source_direction AND o.source_receipt_id=i.source_receipt_id
       AND o.generation=i.generation) THEN
   RAISE EXCEPTION 'Original identity serializer inventory incomplete' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM core.partition p,core.history_family_domain d WHERE p.partition_no=i.partition_no AND p.write_state='active'
   AND p.epoch=i.source_epoch AND p.epoch=i.receiver_epoch AND p.position=i.source_position AND d.singleton
   AND d.generation=i.domain_generation FOR SHARE OF p,d;
 IF NOT FOUND THEN RAISE EXCEPTION 'Identity inventory native fence changed' USING ERRCODE='23514'; END IF;
 -- Match the actual executor codec bytes, including current key version and token.
 expected_receipt:=decode('0101','hex') || substring(int4send(i.partition_no) from 3 for 2) || decode('01','hex') ||
   uuid_send(i.native_principal_id) || int4send(kind_id) ||
   substring(int4send(split_part(i.native_receipt_key,'.',2)::integer) from 3 for 2) ||
   decode(translate(split_part(i.native_receipt_key,'.',3),'-_','+/') || '=', 'base64');
 IF i.expected_locators[1] IS DISTINCT FROM expected_receipt THEN
   RAISE EXCEPTION 'Identity inventory receipt codec mismatch' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.receipt r WHERE r.partition_no=i.partition_no AND r.transaction_id=i.source_transaction_id
   AND r.principal_kind=i.native_principal_kind AND r.principal_id=i.native_principal_id AND r.command_kind=i.native_command_kind
   AND r.idempotency_key=i.native_receipt_key AND r.epoch=i.source_epoch AND r.position=i.source_position
   AND r.xmin::text=pg_current_xact_id()::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Identity inventory lacks original physical receipt' USING ERRCODE='23514'; END IF;
 FOR slot IN SELECT locator,ordinal FROM unnest(i.expected_locators) WITH ORDINALITY AS e(locator,ordinal) LOOP
   SELECT * INTO c FROM core.agent_identity_history_copy WHERE partition_no=i.partition_no AND source_route=i.source_route
     AND source_account_id=i.source_account_id AND source_direction=i.source_direction AND source_receipt_id=i.source_receipt_id
     AND artifact_type=CASE WHEN slot.ordinal=1 THEN 'command-receipt/v1' ELSE 'outbox-event/v1' END AND locator=slot.locator;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'Identity inventory lacks actual expected serializer association' USING ERRCODE='23514'; END IF;
   IF slot.ordinal>1 THEN
     expected_event:=decode('0102','hex') || substring(int4send(i.partition_no) from 3 for 2) || int8send(i.source_position) ||
       substring(int4send((slot.ordinal-2)::integer) from 3 for 2);
     PERFORM 1 FROM core.outbox o WHERE o.partition_no=i.partition_no AND o.epoch=i.source_epoch
       AND o.position=i.source_position AND o.event_seq=slot.ordinal-2 AND o.type=expected_types[(slot.ordinal-1)::integer]
       AND o.xmin::text=pg_current_xact_id()::text;
     IF NOT FOUND OR slot.locator IS DISTINCT FROM expected_event THEN
       RAISE EXCEPTION 'Identity inventory lacks actual expected outbox slot' USING ERRCODE='23514'; END IF;
   END IF;
 END LOOP;
 SELECT count(*) INTO n FROM (SELECT 1 FROM core.agent_identity_history_copy WHERE partition_no=i.partition_no AND source_route=i.source_route
   AND source_account_id=i.source_account_id AND source_direction=i.source_direction AND source_receipt_id=i.source_receipt_id LIMIT 4) c;
 IF n<>cardinality(i.expected_locators) THEN RAISE EXCEPTION 'Identity inventory has unexpected serializer copies' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER agent_identity_inventory_native_commit AFTER INSERT OR UPDATE ON core.agent_identity_inventory
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.validate_agent_identity_inventory();

-- Artifact-leading seeks bind later role/consumer enrollment to the same native generation.
-- They take the inventory write lock before admission returns, excluding every live source hold.
CREATE FUNCTION core.agent_identity_touch_receiving(p_partition integer,p_type text,p_locator bytea)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT source_route,source_account_id,source_direction,source_receipt_id
   FROM core.agent_identity_history_copy WHERE partition_no=p_partition AND artifact_type=p_type AND locator=p_locator
   ORDER BY source_route,source_account_id,source_direction,source_receipt_id LIMIT 2
 LOOP
   n:=n+1;
   IF n>1 THEN RAISE EXCEPTION 'Unconverted original identity association fanout' USING ERRCODE='23514'; END IF;
   UPDATE core.agent_identity_sdk_obligation SET generation=generation+1 WHERE partition_no=p_partition
     AND source_route=r.source_route AND source_account_id=r.source_account_id
     AND source_direction=r.source_direction AND source_receipt_id=r.source_receipt_id;
 END LOOP;
END; $$;
CREATE FUNCTION core.agent_identity_receiving_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_locator bytea; new_locator bytea;
BEGIN
 IF TG_TABLE_NAME='history_locator' THEN
   IF TG_OP<>'INSERT' THEN
     PERFORM core.agent_identity_touch_receiving(OLD.partition_no,OLD.artifact_type,OLD.locator);
   END IF;
   IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR
      (NEW.partition_no,NEW.artifact_type,NEW.locator) IS DISTINCT FROM (OLD.partition_no,OLD.artifact_type,OLD.locator)) THEN
     PERFORM core.agent_identity_touch_receiving(NEW.partition_no,NEW.artifact_type,NEW.locator);
   END IF;
 ELSE
   IF TG_OP<>'INSERT' THEN
     old_locator:=decode('0102','hex') || substring(int4send(OLD.partition_no) from 3 for 2) || int8send(OLD.position) ||
       substring(int4send(OLD.event_seq) from 3 for 2);
     PERFORM core.agent_identity_touch_receiving(OLD.partition_no,'outbox-event/v1',old_locator);
   END IF;
   IF TG_OP<>'DELETE' THEN
     new_locator:=decode('0102','hex') || substring(int4send(NEW.partition_no) from 3 for 2) || int8send(NEW.position) ||
       substring(int4send(NEW.event_seq) from 3 for 2);
     IF TG_OP='INSERT' OR (NEW.partition_no,new_locator) IS DISTINCT FROM (OLD.partition_no,old_locator) THEN
       PERFORM core.agent_identity_touch_receiving(NEW.partition_no,'outbox-event/v1',new_locator);
     END IF;
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_identity_role_enrollment BEFORE INSERT OR DELETE OR
 UPDATE OF partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version ON core.history_locator
 FOR EACH ROW EXECUTE FUNCTION core.agent_identity_receiving_enrollment();
CREATE TRIGGER agent_identity_consumer_enrollment BEFORE INSERT OR UPDATE OR DELETE ON core.history_event_consumer
 FOR EACH ROW EXECUTE FUNCTION core.agent_identity_receiving_enrollment();

-- migrate:down
-- Forward only. Original keys, receipts, associations and unresolved SDK obligations are retained.
