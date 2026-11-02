--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: editorial; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA editorial;


--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: history_store_kind; Type: TYPE; Schema: core; Owner: -
--

CREATE TYPE core.history_store_kind AS ENUM (
    'kernel'
);


--
-- Name: agent_identity_history_copy_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_history_copy_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; n integer := 0; phase text;
BEGIN
 IF TG_OP<>'INSERT' THEN
   RAISE EXCEPTION 'Original Agent identity copy requires native retention discharge' USING ERRCODE='23514';
 END IF;
 -- SHARE the restore/routing generation and exact home through native COMMIT.
 PERFORM 1 FROM core.history_family_domain WHERE singleton AND generation=NEW.domain_generation FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agent identity history domain changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.partition WHERE partition_no=NEW.partition_no AND write_state='active'
   AND epoch=NEW.receiver_epoch AND epoch=NEW.source_epoch AND position=NEW.source_position FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agent identity history home changed' USING ERRCODE='23514'; END IF;
 -- Every technical association is enrolled under the actual copy's complete native role union.
 FOR r IN SELECT account_route,account_id,state FROM core.history_locator
   WHERE partition_no=NEW.partition_no AND artifact_type=NEW.artifact_type AND locator=NEW.locator
   ORDER BY account_route,account_id LIMIT 65 FOR SHARE
 LOOP
   n:=n+1;
   IF n>64 OR r.state<>'pending' THEN
     RAISE EXCEPTION 'Agent identity history role union unavailable' USING ERRCODE='23514';
   END IF;
   SELECT s.phase INTO STRICT phase FROM core.history_seal s
     WHERE s.partition_no=NEW.partition_no AND s.account_route=r.account_route AND s.account_id=r.account_id FOR SHARE;
   IF phase<>'open' THEN RAISE EXCEPTION 'history account partition is sealed' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n=0 THEN RAISE EXCEPTION 'Agent identity history role union unavailable' USING ERRCODE='23514'; END IF;
 PERFORM core.history_family_touch_artifact(NEW.partition_no,NEW.artifact_type,NEW.locator);
 RETURN NEW;
END; $$;


--
-- Name: agent_identity_inventory_copy_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_inventory_copy_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i core.agent_identity_inventory; s access.agent_identity_intent;
 a access.agent_identity_recovery; expected bytea;
BEGIN
 SELECT * INTO s FROM access.agent_identity_intent
 WHERE route=NEW.source_route AND account_id=NEW.source_account_id
   AND direction=NEW.source_direction AND receipt_id=NEW.source_receipt_id
   AND source_partition=NEW.partition_no AND intent_digest=NEW.source_digest
   AND xmin::text=pg_current_xact_id()::text FOR SHARE;
 IF FOUND THEN
   SELECT * INTO a FROM access.agent_identity_recovery
   WHERE route=s.route AND account_id=s.account_id AND direction=s.direction AND receipt_id=s.receipt_id
     AND (source_partition,recovery_epoch,recovery_position,recovery_transaction_id)=
       (NEW.partition_no,NEW.source_epoch,NEW.source_position,NEW.source_transaction_id)
     AND xmin::text=pg_current_xact_id()::text FOR SHARE;
   IF FOUND AND access.agent_identity_recovery_valid(s) THEN
     IF NEW.artifact_type='command-receipt/v1' THEN
       expected:=decode('0101','hex') || substring(int4send(NEW.partition_no) from 3 for 2) || decode('01','hex') ||
         uuid_send(a.requested_by) || int4send(7) ||
         substring(int4send(split_part(a.recovery_receipt_key,'.',2)::integer) from 3 for 2) ||
         decode(translate(split_part(a.recovery_receipt_key,'.',3),'-_','+/') || '=', 'base64');
     ELSIF NEW.artifact_type='outbox-event/v1' THEN
       expected:=decode('0102','hex') || substring(int4send(NEW.partition_no) from 3 for 2) ||
         int8send(NEW.source_position) || decode('0000','hex');
       PERFORM 1 FROM core.outbox o WHERE o.partition_no=NEW.partition_no AND o.epoch=NEW.source_epoch
         AND o.position=NEW.source_position AND o.event_seq=0 AND o.event_count=1
         AND o.type='com.rezics.access.account-updated.v1' AND o.subject=s.account_id::text
         AND o.data=jsonb_build_object('accountId',s.account_id::text) AND o.payload_state='present'
         AND o.xmin::text=pg_current_xact_id()::text;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Recovery copy lacks its actual account wakeup' USING ERRCODE='23514';
       END IF;
     END IF;
     IF expected IS NULL OR NEW.locator IS DISTINCT FROM expected THEN
       RAISE EXCEPTION 'Recovery copy lacks its actual native codec' USING ERRCODE='23514';
     END IF;
     RETURN NEW;
   END IF;
 END IF;
 -- Retain the exact original-writer admission rule for every other producer.
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


--
-- Name: agent_identity_inventory_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_inventory_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: agent_identity_receiving_enrollment(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_receiving_enrollment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: agent_identity_recovery_copy_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_recovery_copy_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a access.agent_identity_recovery; i core.agent_identity_recovery_inventory; expected bytea;
 actual_accounts jsonb; role_count integer;
BEGIN
 SELECT * INTO a FROM access.agent_identity_recovery WHERE route=NEW.source_route
   AND account_id=NEW.source_account_id AND direction=NEW.source_direction AND receipt_id=NEW.source_receipt_id
   AND xmin::text=pg_current_xact_id()::text FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF (a.source_partition,a.intent_digest,a.recovery_epoch,a.recovery_position,a.recovery_transaction_id)
    IS DISTINCT FROM (NEW.partition_no,NEW.source_digest,NEW.source_epoch,NEW.source_position,NEW.source_transaction_id) THEN
   RAISE EXCEPTION 'Recovery identity copy has a foreign recovery tuple' USING ERRCODE='23514'; END IF;
 SELECT * INTO i FROM core.agent_identity_recovery_inventory WHERE partition_no=NEW.partition_no
   AND source_route=NEW.source_route AND source_account_id=NEW.source_account_id
   AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id
   AND recovery_epoch=NEW.source_epoch AND recovery_position=NEW.source_position
   AND recovery_transaction_id=NEW.source_transaction_id AND state='declared'
   AND native_writer_state='open' AND xmin::text=pg_current_xact_id()::text FOR SHARE;
 IF NOT FOUND OR i.source_digest<>NEW.source_digest OR i.receiver_epoch<>NEW.receiver_epoch OR
    i.domain_generation<>NEW.domain_generation OR i.native_command_kind<>'access.agent-identity.recover' OR
    i.native_principal_id<>a.requested_by OR i.native_receipt_key<>a.recovery_receipt_key THEN
   RAISE EXCEPTION 'Recovery identity copy requires its exact native cut declaration' USING ERRCODE='23514'; END IF;
 IF NEW.artifact_type='command-receipt/v1' THEN
   expected:=decode('0101','hex')||substring(int4send(i.partition_no) from 3 for 2)||decode('01','hex')||
     uuid_send(i.native_principal_id)||int4send(7)||
     substring(int4send(split_part(i.native_receipt_key,'.',2)::integer) from 3 for 2)||
     decode(translate(split_part(i.native_receipt_key,'.',3),'-_','+/')||'=','base64');
 ELSIF NEW.artifact_type='outbox-event/v1' THEN
   expected:=decode('0102','hex')||substring(int4send(i.partition_no) from 3 for 2)||
     int8send(i.recovery_position)||decode('0000','hex');
 ELSE
   RAISE EXCEPTION 'Recovery identity copy artifact type unavailable' USING ERRCODE='23514';
 END IF;
 IF NEW.locator IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'Recovery identity copy locator differs from its actual serializer' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(jsonb_build_array(account_route,account_id::text,roles) ORDER BY account_route,account_id),count(*)
   INTO actual_accounts,role_count FROM (
     SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
     WHERE partition_no=NEW.partition_no AND artifact_type=NEW.artifact_type AND locator=NEW.locator
     ORDER BY account_route,account_id LIMIT 65 FOR SHARE
   ) scope;
 IF role_count NOT BETWEEN 1 AND 64 OR actual_accounts IS DISTINCT FROM i.expected_accounts OR
    EXISTS (SELECT 1 FROM core.history_locator WHERE partition_no=NEW.partition_no
      AND artifact_type=NEW.artifact_type AND locator=NEW.locator AND minimizer_version<>1) THEN
   RAISE EXCEPTION 'Recovery identity copy role manifest differs from its serializer scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: agent_identity_recovery_inventory_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_recovery_inventory_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a access.agent_identity_recovery; r core.receipt; declared_xmin text;
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Recovery identity inventory is permanent' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'declared' OR NEW.generation<>1 OR NEW.native_writer_state<>'open' OR NEW.expected_locators IS NOT NULL OR
      NEW.expected_event_types IS NOT NULL THEN
     RAISE EXCEPTION 'Recovery identity inventory requires its declaration phase' USING ERRCODE='23514'; END IF;
   SELECT * INTO a FROM access.agent_identity_recovery WHERE route=NEW.source_route
     AND account_id=NEW.source_account_id AND direction=NEW.source_direction AND receipt_id=NEW.source_receipt_id
     AND source_partition=NEW.partition_no AND intent_digest=NEW.source_digest
     AND recovery_epoch=NEW.recovery_epoch AND recovery_position=NEW.recovery_position
     AND recovery_transaction_id=NEW.recovery_transaction_id AND xmin::text=pg_current_xact_id()::text FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Recovery identity inventory requires its actual Access writer' USING ERRCODE='23514'; END IF;
   SELECT * INTO r FROM core.receipt WHERE partition_no=NEW.partition_no AND principal_kind=NEW.native_principal_kind
     AND principal_id=NEW.native_principal_id AND command_kind=NEW.native_command_kind
     AND idempotency_key=NEW.native_receipt_key AND transaction_id=NEW.recovery_transaction_id
     AND epoch=NEW.recovery_epoch AND position=NEW.recovery_position AND payload_state='present'
     AND request_digest=NEW.native_request_digest AND xmin::text=pg_current_xact_id()::text FOR SHARE;
   IF NOT FOUND OR NEW.native_receipt_key<>a.recovery_receipt_key OR NEW.native_principal_id<>a.requested_by OR
      (a.recovery_digest IS NOT NULL AND encode(NEW.native_request_digest,'hex')<>a.recovery_digest) THEN
     RAISE EXCEPTION 'Recovery identity inventory requires its actual command receipt' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM core.partition p JOIN core.history_family_domain d ON d.singleton
     WHERE p.partition_no=NEW.partition_no AND p.write_state='active' AND p.epoch=NEW.recovery_epoch
       AND p.position=NEW.recovery_position-1 AND d.generation=NEW.domain_generation FOR SHARE OF p,d;
   IF NOT FOUND THEN RAISE EXCEPTION 'Recovery identity inventory home unavailable' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 SELECT xmin::text INTO declared_xmin FROM core.agent_identity_recovery_inventory
   WHERE partition_no=OLD.partition_no AND source_route=OLD.source_route
     AND source_account_id=OLD.source_account_id AND source_direction=OLD.source_direction
     AND source_receipt_id=OLD.source_receipt_id AND state='declared';
 IF declared_xmin IS DISTINCT FROM pg_current_xact_id()::text OR OLD.state<>'declared' OR NEW.state<>'sealed' OR
    NEW.native_writer_state<>'closed' OR
    (to_jsonb(NEW)-ARRAY['expected_locators','expected_event_types','native_writer_state','state']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['expected_locators','expected_event_types','native_writer_state','state']) OR
    NEW.generation<>1 OR NEW.expected_locators IS NULL OR cardinality(NEW.expected_locators)<>2 OR
    NEW.expected_event_types IS NULL OR
    NEW.expected_event_types IS DISTINCT FROM ARRAY['com.rezics.access.account-updated.v1'] THEN
   RAISE EXCEPTION 'Recovery identity inventory permits only one exact seal' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.partition p JOIN core.history_family_domain d ON d.singleton
   WHERE p.partition_no=NEW.partition_no AND p.write_state='active' AND p.epoch=NEW.recovery_epoch
     AND p.position=NEW.recovery_position AND d.generation=NEW.domain_generation FOR SHARE OF p,d;
 IF NOT FOUND THEN RAISE EXCEPTION 'Recovery identity serializer fence changed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: agent_identity_sdk_obligation_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_sdk_obligation_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: agent_identity_touch_receiving(integer, text, bytea); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.agent_identity_touch_receiving(p_partition integer, p_type text, p_locator bytea) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN
   SELECT c.source_route,c.source_account_id,c.source_direction,c.source_receipt_id
   FROM core.agent_identity_history_copy c
   JOIN core.agent_identity_inventory i ON i.partition_no=c.partition_no
     AND i.source_route=c.source_route AND i.source_account_id=c.source_account_id
     AND i.source_direction=c.source_direction AND i.source_receipt_id=c.source_receipt_id
     AND i.state='sealed' AND i.native_writer_state='closed'
     AND i.source_digest=c.source_digest AND i.source_epoch=c.source_epoch
     AND i.source_position=c.source_position AND i.source_transaction_id=c.source_transaction_id
     AND c.receiver_epoch=i.receiver_epoch AND c.domain_generation=i.domain_generation
     AND c.locator=ANY(i.expected_locators)
   WHERE c.partition_no=p_partition AND c.artifact_type=p_type AND c.locator=p_locator
   ORDER BY c.source_route,c.source_account_id,c.source_direction,c.source_receipt_id LIMIT 2
 LOOP
   n:=n+1;
   IF n>1 THEN RAISE EXCEPTION 'Unconverted original identity association fanout' USING ERRCODE='23514'; END IF;
   UPDATE core.agent_identity_sdk_obligation SET generation=generation+1 WHERE partition_no=p_partition
     AND source_route=r.source_route AND source_account_id=r.source_account_id
     AND source_direction=r.source_direction AND source_receipt_id=r.source_receipt_id;
 END LOOP;
END $$;


--
-- Name: check_agent_identity_history(uuid, jsonb, jsonb, jsonb, text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.check_agent_identity_history(p_custody uuid, p_binding jsonb, p_authority jsonb, p_writer jsonb, p_phase text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE m core.agent_identity_work; roles jsonb; n integer; valid_roles boolean; b jsonb; a jsonb; w record;
BEGIN
 SELECT * INTO STRICT m FROM core.agent_identity_work WHERE custody_id=p_custody FOR SHARE;
 IF NOT m.creation_captured OR m.source IS NULL OR m.request_digest IS NULL OR p_authority IS NULL OR
    p_writer IS NULL OR p_phase IS NULL OR p_phase NOT IN ('readiness','closure') OR
    p_binding->>'kind' IS DISTINCT FROM 'access.agent-identity.sdk-retirement/v1' OR
    p_binding->>'custodyId' IS DISTINCT FROM m.custody_id::text OR
    p_binding->>'workflowId' IS DISTINCT FROM m.workflow_id OR
    p_binding->>'requestDigest' IS DISTINCT FROM encode(m.request_digest,'hex') OR
    p_binding->'source' IS DISTINCT FROM m.source OR
    m.source_key::jsonb IS DISTINCT FROM jsonb_build_array(p_authority->'reference'->'receipt'->>'kind',
      p_authority->'reference'->'receipt'->>'account',p_authority->'reference'->'receipt'->>'receipt') OR
    p_binding->'receiver' IS DISTINCT FROM jsonb_build_object('partition',0,'epoch',m.receiver_epoch,
       'generation',m.receiver_generation::text,'writerVersion',1) OR
    p_writer->>'workflowID' IS DISTINCT FROM m.workflow_id OR
    p_authority->'reference'->'barrier' IS DISTINCT FROM p_binding->'barrier' OR
    (p_authority->'reference'->'source'->>'partition')::integer IS DISTINCT FROM 0 OR
    (p_authority->'reference'->'source'->>'epoch')::integer IS DISTINCT FROM (m.source->>'epoch')::integer OR
    p_authority->'reference'->'source'->>'position' IS DISTINCT FROM m.source->>'position' OR
    p_authority->'reference'->'source'->>'transactionId' IS DISTINCT FROM m.source->>'transactionId' OR
    p_authority->'reference'->>'sourceDigest' IS DISTINCT FROM m.source->>'digest' OR
    (m.history_authority IS NOT NULL AND m.history_authority IS DISTINCT FROM p_authority) THEN
   RAISE EXCEPTION 'identity History original binding changed' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM core.partition p,core.history_family_domain d WHERE p.partition_no=0 AND p.write_state='active' AND p.moved_to IS NULL
   AND p.epoch=m.receiver_epoch AND d.singleton AND d.generation=m.receiver_generation FOR SHARE OF p,d;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity History receiving custody changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.history_work WHERE partition_no=0 AND work_id=m.custody_id
   AND owner='access.agent-identity' AND request_digest=m.request_digest FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity History original work changed' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(jsonb_build_object('accountRoute',account_route,'accountId',account_id,'roles',original_roles.roles)
   ORDER BY account_route,account_id),count(*),bool_and(minimizer_version=1) INTO roles,n,valid_roles FROM (
   SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
   WHERE partition_no=0 AND artifact_type='durable-work/v1'
     AND locator=decode('0103','hex')||convert_to(m.custody_id::text,'UTF8')
   ORDER BY account_route,account_id LIMIT 65 FOR SHARE
 ) original_roles;
 IF n NOT BETWEEN 1 AND 64 OR NOT valid_roles OR roles IS DISTINCT FROM m.accounts OR NOT (roles @> jsonb_build_array(jsonb_build_object(
   'accountId',p_binding->'barrier'->>'accountId','accountRoute',(p_binding->'barrier'->>'accountRoute')::integer))) THEN RAISE EXCEPTION 'identity History role scope changed' USING ERRCODE='23514'; END IF;
 SELECT jsonb_build_object('accountId',account_id,'accountRoute',route,'version',version,'at',at::text) INTO b
   FROM access.erasure WHERE route=(p_binding->'barrier'->>'accountRoute')::integer
     AND account_id=(p_binding->'barrier'->>'accountId')::uuid FOR SHARE;
 IF b IS DISTINCT FROM p_binding->'barrier' THEN
   RAISE EXCEPTION 'identity History barrier changed' USING ERRCODE='23514'; END IF;
 SELECT semantic.lock_identity_source_history_handoff(p_authority->'reference',p_authority) INTO a;
 IF a IS NULL OR a IS DISTINCT FROM p_authority THEN
   RAISE EXCEPTION 'identity History Source authority changed' USING ERRCODE='23514'; END IF;
 IF p_phase='closure' AND (m.sdk_readiness IS NULL OR
      p_writer->>'restoreGeneration' IS DISTINCT FROM m.sdk_readiness->'writer'->>'restoreGeneration') THEN
   RAISE EXCEPTION 'identity History original SDK restore generation changed' USING ERRCODE='23514'; END IF;
 IF (p_phase='readiness' AND (p_writer->>'generation' IS DISTINCT FROM '1' OR
       p_writer->>'closureID' IS NOT NULL OR p_writer->>'closedAt' IS NOT NULL)) OR
    (p_phase='closure' AND (p_writer->>'generation' IS DISTINCT FROM '2' OR
       p_writer->>'closureID' IS NULL OR p_writer->>'closedAt' IS NULL)) THEN
   RAISE EXCEPTION 'identity History writer phase changed' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT w FROM dbos.check_workflow_writer_state(m.workflow_id,
   (p_writer->>'restoreGeneration')::uuid,(p_writer->>'generation')::bigint,
   (p_writer->>'closureID')::uuid,(p_writer->>'closedAt')::bigint);
END; $$;


--
-- Name: check_agent_identity_history_absence(uuid); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.check_agent_identity_history_absence(p_custody uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE id text;
BEGIN
 SELECT workflow_id INTO STRICT id FROM core.agent_identity_work WHERE custody_id=p_custody FOR SHARE;
 IF EXISTS(SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.workflow_input WHERE workflow_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.workflow_output WHERE workflow_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.operation_outputs WHERE workflow_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.workflow_events WHERE workflow_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.workflow_events_history WHERE workflow_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.notifications WHERE destination_uuid=id LIMIT 1) OR
    EXISTS(SELECT 1 FROM dbos.streams WHERE workflow_uuid=id LIMIT 1) THEN
   RAISE EXCEPTION 'identity History physical copy remains' USING ERRCODE='23514'; END IF;
END; $$;


--
-- Name: guard_agent_identity_history_receiving(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.guard_agent_identity_history_receiving() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE id uuid; m core.agent_identity_work; w core.history_work; role_hash bytea;
BEGIN
 IF NEW.artifact_type<>'durable-work/v1' OR NEW.partition_no<>0 OR substring(NEW.locator from 1 for 2)<>decode('0103','hex') OR
    convert_from(substring(NEW.locator from 3),'UTF8') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
 id:=convert_from(substring(NEW.locator from 3),'UTF8')::uuid;
 SELECT * INTO m FROM core.agent_identity_work WHERE custody_id=id FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='history_locator' AND NEW.state<>'minimized' THEN RETURN NEW; END IF;
 PERFORM core.check_agent_identity_history(id,m.sdk_readiness->'binding',m.history_authority,m.sdk_closure,'closure');
 PERFORM core.check_agent_identity_history_absence(id);
 SELECT * INTO STRICT w FROM core.history_work WHERE partition_no=0 AND work_id=id FOR SHARE;
 IF w.state<>'retired' OR NOT w.owner_ready OR NOT w.absence_verified OR w.request IS NOT NULL OR w.scope IS NOT NULL OR
    NEW.account_id::text IS DISTINCT FROM m.sdk_readiness->'binding'->'barrier'->>'accountId' OR
    NEW.account_route::text IS DISTINCT FROM m.sdk_readiness->'binding'->'barrier'->>'accountRoute' THEN
   RAISE EXCEPTION 'identity History receiving copy is not closed' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='history_receiving_proof' THEN
   SELECT sha256(convert_to(replace(json_agg(json_build_array(account_route,account_id,roles)
      ORDER BY account_route,account_id)::text,' ',''),'UTF8')) INTO role_hash FROM (
     SELECT account_route,account_id,roles FROM core.history_locator WHERE partition_no=0
       AND artifact_type='durable-work/v1' AND locator=NEW.locator ORDER BY account_route,account_id LIMIT 65 FOR SHARE
   ) original_roles;
   IF NEW.role_digest IS DISTINCT FROM role_hash THEN
     RAISE EXCEPTION 'identity History receiving role digest changed' USING ERRCODE='23514'; END IF;
   IF NEW.partition_epoch<>m.receiver_epoch OR NEW.barrier_version::text IS DISTINCT FROM m.sdk_readiness->'binding'->'barrier'->>'version' OR
      NEW.barrier_at IS DISTINCT FROM m.sdk_readiness->'binding'->'barrier'->>'at' OR NOT EXISTS (
       SELECT 1 FROM core.history_locator WHERE partition_no=0 AND account_route=NEW.account_route AND account_id=NEW.account_id
         AND artifact_type=NEW.artifact_type AND locator=NEW.locator AND state='minimized' AND proof_barrier=NEW.account_id FOR SHARE
      ) THEN RAISE EXCEPTION 'identity History receiving barrier changed' USING ERRCODE='23514'; END IF;
 ELSIF NEW.proof_barrier IS DISTINCT FROM NEW.account_id THEN
   RAISE EXCEPTION 'identity History locator barrier changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $_$;


--
-- Name: guard_agent_identity_sdk_retirement(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.guard_agent_identity_sdk_retirement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE m core.agent_identity_work;
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.owner='access.agent-identity' THEN RAISE EXCEPTION 'native identity SDK retirement custody is permanent' USING ERRCODE='23514'; END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.owner='access.agent-identity' AND
    (NEW.owner,NEW.work_id,NEW.partition_no,NEW.request_digest,NEW.source_partition,NEW.source_transaction) IS DISTINCT FROM
    (OLD.owner,OLD.work_id,OLD.partition_no,OLD.request_digest,OLD.source_partition,OLD.source_transaction) THEN
   RAISE EXCEPTION 'native identity SDK retirement binding is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.owner='access.agent-identity' AND
    ((NEW.request IS DISTINCT FROM OLD.request AND NEW.request IS NOT NULL) OR
     (NEW.scope IS DISTINCT FROM OLD.scope AND NEW.scope IS NOT NULL)) THEN
   RAISE EXCEPTION 'native identity History payload is immutable until guarded clearing' USING ERRCODE='23514'; END IF;
 IF NEW.owner='access.agent-identity' AND (NEW.owner_ready OR NEW.absence_verified OR NEW.state<>'pending' OR NEW.retired_at IS NOT NULL OR
    (TG_OP='UPDATE' AND (NEW.request IS DISTINCT FROM OLD.request OR NEW.scope IS DISTINCT FROM OLD.scope))) THEN
   SELECT * INTO STRICT m FROM core.agent_identity_work WHERE custody_id=NEW.work_id::uuid FOR SHARE;
   IF m.sdk_readiness IS NULL OR NOT NEW.owner_ready THEN
     RAISE EXCEPTION 'identity SDK retirement requires durable source transfer' USING ERRCODE='23514'; END IF;
   PERFORM core.check_agent_identity_history(m.custody_id,m.sdk_readiness->'binding',m.history_authority,
     CASE WHEN m.sdk_closure IS NULL THEN m.sdk_readiness->'writer' ELSE m.sdk_closure END,
     CASE WHEN m.sdk_closure IS NULL THEN 'readiness' ELSE 'closure' END);
   IF (NEW.state='retired' OR NEW.absence_verified OR NEW.request IS NULL OR NEW.scope IS NULL) AND m.sdk_closure IS NULL THEN
     RAISE EXCEPTION 'identity History permanent SDK closure missing' USING ERRCODE='23514'; END IF;
   IF NEW.absence_verified THEN PERFORM core.check_agent_identity_history_absence(m.custody_id); END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_agent_identity_work(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.guard_agent_identity_work() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.history_authority IS NOT NULL OR NEW.sdk_readiness IS NOT NULL OR NEW.sdk_closure IS NOT NULL OR NEW.sdk_retirement_receipt IS NOT NULL THEN
     RAISE EXCEPTION 'identity History readiness requires original association' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' OR TG_TABLE_NAME='agent_identity_work_source' THEN
   RAISE EXCEPTION 'native identity SDK custody is permanent' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['source','creation_captured','request_digest','history_authority','sdk_readiness','sdk_closure','sdk_retirement_receipt']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['source','creation_captured','request_digest','history_authority','sdk_readiness','sdk_closure','sdk_retirement_receipt']) OR
    (OLD.source IS NOT NULL AND NEW.source IS DISTINCT FROM OLD.source) OR
    (OLD.request_digest IS NOT NULL AND NEW.request_digest IS DISTINCT FROM OLD.request_digest) OR
    (OLD.creation_captured AND NOT NEW.creation_captured) OR
    (OLD.history_authority IS NOT NULL AND NEW.history_authority IS DISTINCT FROM OLD.history_authority) OR
    (OLD.sdk_readiness IS NOT NULL AND NEW.sdk_readiness IS DISTINCT FROM OLD.sdk_readiness) OR
    (OLD.sdk_closure IS NOT NULL AND NEW.sdk_closure IS DISTINCT FROM OLD.sdk_closure) OR
    (OLD.sdk_retirement_receipt IS NOT NULL AND NEW.sdk_retirement_receipt IS DISTINCT FROM OLD.sdk_retirement_receipt) THEN
   RAISE EXCEPTION 'native identity SDK custody is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.sdk_readiness IS DISTINCT FROM OLD.sdk_readiness THEN
   PERFORM core.check_agent_identity_history(NEW.custody_id,NEW.sdk_readiness->'binding',NEW.history_authority,
     NEW.sdk_readiness->'writer','readiness');
 END IF;
 IF NEW.sdk_retirement_receipt IS DISTINCT FROM OLD.sdk_retirement_receipt THEN
   -- Captured SDK evidence only. This does not authorize source discharge or history_work retirement.
   IF NOT NEW.creation_captured OR NEW.source IS NULL OR NEW.request_digest IS NULL OR
      NEW.sdk_retirement_receipt->>'sourceGeneration' IS DISTINCT FROM NEW.receiver_generation::text OR
      NEW.sdk_retirement_receipt->'binding'->>'kind' IS DISTINCT FROM 'access.agent-identity.sdk-retirement/v1' OR
      NEW.sdk_retirement_receipt->'binding'->>'custodyId' IS DISTINCT FROM NEW.custody_id::text OR
      NEW.sdk_retirement_receipt->'binding'->>'workflowId' IS DISTINCT FROM NEW.workflow_id OR
      NEW.sdk_retirement_receipt->'binding'->>'requestDigest' IS DISTINCT FROM encode(NEW.request_digest,'hex') OR
      NEW.sdk_retirement_receipt->'binding'->'source' IS DISTINCT FROM NEW.source OR
      NEW.sdk_retirement_receipt->'binding'->'receiver' IS DISTINCT FROM
        jsonb_build_object('partition',0,'epoch',NEW.receiver_epoch,'generation',NEW.receiver_generation::text,'writerVersion',1) OR
      NEW.sdk_retirement_receipt->'fence'->>'workflowID' IS DISTINCT FROM NEW.workflow_id OR
      NEW.sdk_retirement_receipt->'fence'->>'generation' IS DISTINCT FROM '2' OR
      NOT EXISTS(SELECT 1 FROM core.partition p,core.history_family_domain d
        WHERE p.partition_no=0 AND p.write_state='active' AND p.epoch=NEW.receiver_epoch
          AND d.singleton AND d.generation=NEW.receiver_generation) THEN
     RAISE EXCEPTION 'identity SDK receipt requires current original receiving binding' USING ERRCODE='23514';
   END IF;
 END IF;
 IF NEW.sdk_closure IS DISTINCT FROM OLD.sdk_closure THEN
   IF NEW.sdk_readiness IS NULL OR NEW.sdk_retirement_receipt->'binding' IS DISTINCT FROM NEW.sdk_readiness->'binding' OR
      NEW.sdk_retirement_receipt->>'sourceGeneration' IS DISTINCT FROM NEW.receiver_generation::text OR
      NEW.sdk_retirement_receipt->'fence' IS DISTINCT FROM NEW.sdk_closure-'restoreGeneration' THEN
     RAISE EXCEPTION 'identity History exact SDK closure changed' USING ERRCODE='23514'; END IF;
   PERFORM core.check_agent_identity_history(NEW.custody_id,NEW.sdk_readiness->'binding',NEW.history_authority,
     NEW.sdk_closure,'closure');
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_identity_history_allocation(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.guard_identity_history_allocation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE original core.identity_history_original;
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Original partitions cannot be discarded' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO original FROM core.identity_history_original WHERE original_id=NEW.original_id FOR SHARE;
   IF NOT FOUND OR original.allowance IS DISTINCT FROM NEW.parent_work OR
      original.spent IS DISTINCT FROM NEW.parent_work OR NOT original.dispatched THEN
     RAISE EXCEPTION 'Original partitions require committed prepaid admission' USING ERRCODE='23514';
   END IF;
 ELSE
   IF (to_jsonb(NEW)-ARRAY['local_entered','child_entered','child_ended','next_binding']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['local_entered','child_entered','child_ended','next_binding']) OR
      (OLD.local_entered AND NOT NEW.local_entered) OR
      (OLD.child_entered AND NOT NEW.child_entered) OR
      (OLD.child_ended AND NOT NEW.child_ended) OR
      (OLD.next_binding IS NOT NULL AND NEW.next_binding IS DISTINCT FROM OLD.next_binding) THEN
     RAISE EXCEPTION 'Original partitions cannot refill or reopen' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_identity_original_control(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.guard_identity_original_control() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i integer; mutable text[];
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Original admission retains unresolved custody' USING ERRCODE='23514';
 END IF;
 mutable:=CASE WHEN TG_TABLE_NAME='identity_history_original'
   THEN ARRAY['spent','dispatched','advanced'] ELSE ARRAY['spent'] END;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) THEN
   RAISE EXCEPTION 'Original admission identity and ceiling are immutable' USING ERRCODE='23514';
 END IF;
 FOR i IN 1..8 LOOP
   IF NEW.spent[i]<OLD.spent[i] THEN
     RAISE EXCEPTION 'Original admission cannot refund consumed work' USING ERRCODE='23514';
   END IF;
 END LOOP;
 IF TG_TABLE_NAME='identity_history_original' THEN
   IF (OLD.dispatched AND NOT NEW.dispatched) OR (OLD.advanced AND NOT NEW.advanced) THEN
     RAISE EXCEPTION 'Original admission cannot reopen' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: history_auth_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_auth_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.phase='copies-erased' THEN PERFORM core.history_wake_account(NEW.route,NEW.account_id); END IF;
 RETURN NEW;
END; $$;


--
-- Name: history_consumer_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_consumer_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; k bytea;
BEGIN
 IF OLD.state=NEW.state THEN RETURN NEW; END IF;
 k:=decode('0102','hex') || int2send(NEW.partition_no::smallint) || int8send(NEW.position) || int2send(NEW.event_seq::smallint);
 FOR r IN SELECT account_route,account_id FROM core.history_locator
   WHERE partition_no=NEW.partition_no AND artifact_type='outbox-event/v1' AND locator=k
   ORDER BY account_route,account_id LIMIT 64
 LOOP PERFORM core.history_wake_account(r.account_route,r.account_id); END LOOP;
 RETURN NEW;
END; $$;


--
-- Name: history_family_admit(text, integer, uuid); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_admit(p_family text, p_route integer, p_account uuid) RETURNS void
    LANGUAGE sql
    AS $$
 INSERT INTO core.history_family_fence(account_route,account_id) VALUES(p_route,p_account) ON CONFLICT DO NOTHING;
 INSERT INTO core.history_family_coverage(family,account_route,account_id,barrier_version,barrier_at,
   definition_digest,domain_generation,fence_revision)
 SELECT p_family,e.route,e.account_id,e.version,e.at::text,d.digest,g.generation,f.revision
 FROM access.erasure e,core.history_family_definition d,core.history_family_domain g,core.history_family_fence f
 WHERE e.route=p_route AND e.account_id=p_account AND d.family=p_family AND g.singleton
  AND f.account_route=e.route AND f.account_id=e.account_id ON CONFLICT DO NOTHING;
$$;


--
-- Name: history_family_consumer_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_consumer_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; p integer; k bytea;
BEGIN
 IF TG_OP='DELETE' THEN
  p:=OLD.partition_no; k:=decode('0102','hex')||int2send(p::smallint)||int8send(OLD.position)||int2send(OLD.event_seq::smallint);
 ELSE
  p:=NEW.partition_no; k:=decode('0102','hex')||int2send(p::smallint)||int8send(NEW.position)||int2send(NEW.event_seq::smallint);
 END IF;
 FOR r IN SELECT account_route,account_id FROM core.history_locator
  WHERE partition_no=p AND artifact_type='outbox-event/v1' AND locator=k
  ORDER BY account_route,account_id LIMIT 65
 LOOP PERFORM core.history_family_touch(r.account_route,r.account_id); END LOOP;
 RETURN NULL;
END; $$;


--
-- Name: history_family_domain_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_domain_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_LEVEL='ROW' AND TG_OP='UPDATE' THEN
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 END IF;
 UPDATE core.history_family_domain SET generation=generation+1 WHERE singleton;
 RETURN NULL;
END; $$;


--
-- Name: history_family_job_admitted(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_job_admitted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE d record;
BEGIN
 FOR d IN SELECT family FROM core.history_family_definition ORDER BY family LIMIT 9
 LOOP PERFORM core.history_family_admit(d.family,NEW.account_route,NEW.account_id); END LOOP;
 RETURN NULL;
END; $$;


--
-- Name: history_family_physical_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_physical_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE k jsonb; t text; r record;
BEGIN
 IF TG_TABLE_NAME='receipt' THEN
  t:='command-receipt/v1'; k:=jsonb_build_array(OLD.principal_kind,OLD.principal_id,OLD.command_kind,OLD.idempotency_key);
 ELSIF TG_TABLE_NAME='outbox' THEN
  t:='outbox-event/v1'; k:=jsonb_build_array(OLD.position::text,OLD.event_seq);
 ELSE
  t:='durable-work/v1'; k:=jsonb_build_array(OLD.work_id);
 END IF;
 FOR r IN SELECT l.account_route,l.account_id FROM core.history_family_watch w
   JOIN core.history_locator l USING(partition_no,artifact_type,locator)
   WHERE w.partition_no=OLD.partition_no AND w.artifact_type=t AND w.source_key=k
   ORDER BY l.account_route,l.account_id LIMIT 65
 LOOP PERFORM core.history_family_touch(r.account_route,r.account_id); END LOOP;
 RETURN NULL;
END; $$;


--
-- Name: history_family_preserve_locator(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_preserve_locator() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE sealed boolean;
BEGIN
 SELECT phase<>'open' INTO sealed FROM core.history_seal WHERE partition_no=OLD.partition_no
  AND account_route=OLD.account_route AND account_id=OLD.account_id FOR SHARE;
 IF TG_OP='DELETE' THEN
  IF sealed OR OLD.state='minimized' THEN
   RAISE EXCEPTION 'sealed history role is irreversible' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF (sealed AND (OLD.partition_no,OLD.account_route,OLD.account_id,OLD.artifact_type,OLD.locator,OLD.roles,OLD.minimizer_version)
   IS DISTINCT FROM (NEW.partition_no,NEW.account_route,NEW.account_id,NEW.artifact_type,NEW.locator,NEW.roles,NEW.minimizer_version))
   OR (OLD.state='minimized' AND (NEW.state<>'minimized' OR NEW.proof_barrier IS DISTINCT FROM OLD.proof_barrier))
 THEN RAISE EXCEPTION 'sealed history role is irreversible' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: history_family_scope_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_scope_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN PERFORM core.history_family_touch(OLD.account_route,OLD.account_id); END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.account_route,NEW.account_id) IS DISTINCT FROM (OLD.account_route,OLD.account_id)) THEN
  PERFORM core.history_family_touch(NEW.account_route,NEW.account_id);
 END IF;
 IF TG_TABLE_NAME IN ('history_locator','history_receiving_proof') THEN
  IF TG_OP<>'INSERT' THEN
   PERFORM core.history_family_touch_artifact(OLD.partition_no,OLD.artifact_type,OLD.locator);
  END IF;
  IF TG_OP<>'DELETE' THEN
   PERFORM core.history_family_touch_artifact(NEW.partition_no,NEW.artifact_type,NEW.locator);
  END IF;
 END IF;
 RETURN NULL;
END; $$;


--
-- Name: history_family_touch(integer, uuid); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_touch(p_route integer, p_account uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
 -- Before erasure there is no issuer or aggregate to invalidate.
 IF EXISTS(SELECT 1 FROM access.erasure WHERE route=p_route AND account_id=p_account) THEN
  INSERT INTO core.history_family_fence(account_route,account_id) VALUES(p_route,p_account)
   ON CONFLICT(account_route,account_id) DO UPDATE SET revision=core.history_family_fence.revision+1;
  UPDATE core.history_family_coverage SET phase='scan',gap=NULL,proof_id=NULL,next_run=now()
   WHERE account_route=p_route AND account_id=p_account;
 END IF;
END; $$;


--
-- Name: history_family_touch_artifact(integer, text, bytea); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_touch_artifact(p_partition integer, p_type text, p_locator bytea) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT account_route,account_id FROM core.history_locator
  WHERE partition_no=p_partition AND artifact_type=p_type AND locator=p_locator
  ORDER BY account_route,account_id LIMIT 65
 LOOP
  n:=n+1;
  IF n>64 THEN RAISE EXCEPTION 'history role union exceeds native bound' USING ERRCODE='23514'; END IF;
  PERFORM core.history_family_touch(r.account_route,r.account_id);
 END LOOP;
END; $$;


--
-- Name: history_family_validate_enrollment(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_family_validate_enrollment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE e record; s record; d record; h record;
BEGIN
 SELECT version,at::text INTO STRICT e FROM access.erasure
  WHERE route=NEW.account_route AND account_id=NEW.account_id FOR SHARE;
 SELECT phase,barrier_id INTO STRICT s FROM core.history_seal WHERE partition_no=NEW.partition_no
  AND account_route=NEW.account_route AND account_id=NEW.account_id FOR SHARE;
 SELECT digest,sources INTO STRICT d FROM core.history_family_definition WHERE family=NEW.family FOR SHARE;
 SELECT epoch,write_state INTO STRICT h FROM core.partition WHERE partition_no=NEW.partition_no FOR SHARE;
 IF h.epoch<>NEW.partition_epoch OR h.write_state<>'active' OR e.version<>NEW.barrier_version OR e.at<>NEW.barrier_at OR s.phase='open' OR s.barrier_id<>NEW.account_id
   OR d.digest<>NEW.definition_digest OR NOT EXISTS(
     SELECT 1 FROM jsonb_to_recordset(d.sources) AS p("artifactType" text,producer text,version integer)
     WHERE p."artifactType"=NEW.artifact_type AND p.producer=NEW.producer AND p.version=NEW.producer_version)
 THEN RAISE EXCEPTION 'history family enrollment does not match native source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: history_guard_locator(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_guard_locator() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE guard_phase text;
BEGIN
  INSERT INTO core.history_seal (partition_no, account_route, account_id)
    VALUES (NEW.partition_no, NEW.account_route, NEW.account_id) ON CONFLICT DO NOTHING;
  SELECT phase INTO STRICT guard_phase FROM core.history_seal
    WHERE partition_no = NEW.partition_no AND account_route = NEW.account_route AND account_id = NEW.account_id
    FOR SHARE;
  IF guard_phase <> 'open' THEN
    RAISE EXCEPTION 'history account partition is sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: history_payload_irreversible(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_payload_irreversible() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_TABLE_NAME='receipt' THEN
   IF OLD.payload_state='minimized' AND (NEW.payload_state<>'minimized' OR NEW.response<>'null'::jsonb) THEN
     RAISE EXCEPTION 'minimized history payload is sealed' USING ERRCODE='23514';
   END IF;
 ELSE
   IF OLD.payload_state='minimized' AND
     (NEW.payload_state<>'minimized' OR NEW.data<>'{}'::jsonb OR NEW.subject IS NOT NULL) THEN
     RAISE EXCEPTION 'minimized history payload is sealed' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: history_preserve_seal(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_preserve_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.phase <> 'open' THEN
      RAISE EXCEPTION 'history seal is irreversible' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.partition_no, NEW.account_route, NEW.account_id) IS DISTINCT FROM
     (OLD.partition_no, OLD.account_route, OLD.account_id) OR
     (OLD.phase <> 'open' AND (NEW.barrier_id IS DISTINCT FROM OLD.barrier_id OR NEW.phase = 'open')) OR
     (OLD.phase = 'complete' AND NEW.phase <> 'complete') THEN
    RAISE EXCEPTION 'history seal is irreversible' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: history_receiving_proof_immutable(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_receiving_proof_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 RAISE EXCEPTION 'history receiving proof is immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: history_retirement_irreversible(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_retirement_irreversible() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF OLD.state='retired' AND (NEW.state<>'retired' OR NEW.request IS NOT NULL OR NEW.scope IS NOT NULL
   OR NEW.request_digest<>OLD.request_digest OR NEW.owner IS DISTINCT FROM OLD.owner
   OR (OLD.absence_verified AND NOT NEW.absence_verified)) THEN
   RAISE EXCEPTION 'retired history work is sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: history_wake_account(integer, uuid); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_wake_account(p_route integer, p_account uuid) RETURNS void
    LANGUAGE sql
    AS $$
 UPDATE core.preference_history_job SET phase='scan',scan_partition=0,scan_type=NULL,scan_locator=NULL,
   verify_partition=0,gap=NULL,next_run=now()
 WHERE account_route=p_route AND account_id=p_account AND phase='pending';
$$;


--
-- Name: history_work_changed(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_work_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; k bytea;
BEGIN
 IF (OLD.owner_ready,OLD.absence_verified) IS NOT DISTINCT FROM (NEW.owner_ready,NEW.absence_verified) THEN RETURN NEW; END IF;
 k:=decode('0103','hex') || convert_to(NEW.work_id::text,'UTF8');
 FOR r IN SELECT account_route,account_id FROM core.history_locator
   WHERE partition_no=NEW.partition_no AND artifact_type='durable-work/v1' AND locator=k
   ORDER BY account_route,account_id LIMIT 64
 LOOP PERFORM core.history_wake_account(r.account_route,r.account_id); END LOOP;
 RETURN NEW;
END; $$;


--
-- Name: identity_original_sum(bigint[], bigint[], bigint[], bigint[]); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.identity_original_sum(a bigint[], b bigint[], c bigint[], d bigint[]) RETURNS bigint[]
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT array_agg(a[i]+coalesce(b[i],0)+coalesce(c[i],0)+d[i] ORDER BY i)
 FROM generate_series(1,8) i
$$;


--
-- Name: identity_original_vector_valid(bigint[]); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.identity_original_vector_valid(v bigint[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT array_ndims(v)=1 AND array_lower(v,1)=1 AND cardinality(v)=8
   AND NOT EXISTS(SELECT 1 FROM unnest(v) n WHERE n IS NULL OR n<0 OR n>9007199254740991)
$$;


--
-- Name: operational_work_custody_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_custody_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE id uuid; p integer; own boolean;
BEGIN
  IF TG_TABLE_NAME='history_work' THEN
    IF TG_OP='DELETE' THEN
      IF OLD.owner='library.members-preparation' THEN
        RAISE EXCEPTION 'operational History inventory is permanent' USING ERRCODE='23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.owner IS DISTINCT FROM 'library.members-preparation' AND
       (TG_OP='INSERT' OR OLD.owner IS DISTINCT FROM 'library.members-preparation') THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND
       (to_jsonb(OLD)-ARRAY['state','owner_ready','retired_at','absence_verified']) IS DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['state','owner_ready','retired_at','absence_verified']) THEN
      RAISE EXCEPTION 'operational History original inventory is immutable' USING ERRCODE='23514';
    END IF;
    id:=NEW.work_id; p:=NEW.partition_no;
    IF NOT (NEW.state='retired' OR NEW.absence_verified OR NEW.owner_ready) THEN RETURN NEW; END IF;
  ELSE
    IF TG_OP='DELETE' THEN
      IF OLD.artifact_type='durable-work/v1' AND substring(OLD.locator FROM 3 FOR 9)=convert_to('6f70776b-','UTF8') THEN
        RAISE EXCEPTION 'operational History inventory is permanent' USING ERRCODE='23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.artifact_type<>'durable-work/v1' THEN RETURN NEW; END IF;
    -- Namespace selects a probe only; the exact durable records below supply authority.
    IF substring(NEW.locator FROM 3 FOR 9)<>convert_to('6f70776b-','UTF8') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='history_locator' AND NEW.state<>'minimized' THEN RETURN NEW; END IF;
    BEGIN id:=convert_from(substring(NEW.locator FROM 3),'UTF8')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
    p:=NEW.partition_no;
  END IF;
  SELECT EXISTS(SELECT 1 FROM core.operational_work_original WHERE partition_no=p AND custody_id=id)
    OR EXISTS(SELECT 1 FROM core.operational_work_mapping WHERE partition_no=p AND custody_id=id) INTO own;
  IF own THEN
    RAISE EXCEPTION 'operational-work-source-currentness-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: operational_work_head_bound(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_head_bound() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM core.operational_work_original o WHERE o.partition_no=NEW.partition_no AND
      o.custody_id=NEW.custody_id AND o.transaction_id=NEW.transaction_id AND o.workflow_id=NEW.workflow_id AND
      o.request_digest=NEW.request_digest AND o.deadline=NEW.deadline AND o.source_domain=NEW.domain AND
      o.source_epoch=NEW.epoch AND o.source_generation=NEW.generation AND o.source_position=NEW.position AND o.sealed) THEN
    RAISE EXCEPTION 'operational-work-native-position-binding-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;


--
-- Name: operational_work_head_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_head_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: operational_work_immutable(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'operational History identity is permanent' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='operational_work_original' AND NOT OLD.sealed AND NEW.sealed AND
     (to_jsonb(OLD)-ARRAY['source_epoch','sealed'])=(to_jsonb(NEW)-ARRAY['source_epoch','sealed']) THEN
    RETURN NEW;
  END IF;
  IF OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'operational History identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: operational_work_mapping_stamp(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_mapping_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: operational_work_position_binding(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_position_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: operational_work_require_native_seal(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_require_native_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: operational_work_role_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_role_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE scope jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.artifact_type='durable-work/v1' AND substring(OLD.locator FROM 3 FOR 9)=convert_to('6f70776b-','UTF8') AND
       (OLD.partition_no,OLD.account_route,OLD.account_id,OLD.artifact_type,OLD.locator,OLD.roles,OLD.minimizer_version)
       IS DISTINCT FROM
       (NEW.partition_no,NEW.account_route,NEW.account_id,NEW.artifact_type,NEW.locator,NEW.roles,NEW.minimizer_version) THEN
      RAISE EXCEPTION 'operational History original roles are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.artifact_type<>'durable-work/v1' OR substring(NEW.locator FROM 3 FOR 9)<>convert_to('6f70776b-','UTF8') THEN RETURN NEW; END IF;
  SELECT o.scope INTO scope FROM core.operational_work_original o
    WHERE o.partition_no=NEW.partition_no AND o.custody_id=convert_from(substring(NEW.locator FROM 3),'UTF8')::uuid FOR SHARE;
  IF NOT FOUND THEN
    SELECT m.source->'scope' INTO scope FROM core.operational_work_mapping m
      WHERE m.partition_no=NEW.partition_no AND m.custody_id=convert_from(substring(NEW.locator FROM 3),'UTF8')::uuid FOR SHARE;
  END IF;
  IF scope IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_to_recordset(scope->'accounts') a("accountRoute" integer,"accountId" uuid,roles integer)
    WHERE a."accountRoute"=NEW.account_route AND a."accountId"=NEW.account_id AND a.roles=NEW.roles) THEN
    RAISE EXCEPTION 'operational History original roles differ' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: operational_work_selected_continuation_bound(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_selected_continuation_bound() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent core.operational_work_selection;
BEGIN
  SELECT * INTO parent FROM core.operational_work_selection
    WHERE partition_no=NEW.partition_no AND workflow_id=NEW.parent_workflow_id AND function_id=NEW.parent_function_id FOR SHARE;
  IF NOT FOUND OR parent.result->>'kind' IS DISTINCT FROM 'continue' OR
     parent.result->>'continuation' IS DISTINCT FROM NEW.workflow_id OR
     (parent.custody_id,parent.route,parent.owner_account_id,parent.collection_id,parent.episode_id) IS DISTINCT FROM
     (NEW.custody_id,NEW.route,NEW.owner_account_id,NEW.collection_id,NEW.episode_id) THEN
    RAISE EXCEPTION 'selected continuation lacks atomic parent result' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;


--
-- Name: operational_work_selection_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.operational_work_selection_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'selected operational association is permanent' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='operational_work_selection' THEN
    IF OLD.result IS NULL AND NEW.result IS NOT NULL AND
       (to_jsonb(OLD)-'result')=(to_jsonb(NEW)-'result') THEN RETURN NEW; END IF;
  END IF;
  IF OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'selected operational association is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: record_history_preserve_copy(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.record_history_preserve_copy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'record history association is immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.source_key,NEW.partition_no,NEW.artifact_type,NEW.locator,NEW.original_transaction,NEW.producer_version,NEW.coverage)
   IS DISTINCT FROM
   (OLD.source_key,OLD.partition_no,OLD.artifact_type,OLD.locator,OLD.original_transaction,OLD.producer_version,OLD.coverage)
   OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position)
   OR (OLD.state='minimized' AND NEW.state<>'minimized') THEN
   RAISE EXCEPTION 'record history association is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_history_preserve_purge_set(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.record_history_preserve_purge_set() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'next_attempt') IS DISTINCT FROM (to_jsonb(OLD)-'next_attempt') THEN
   RAISE EXCEPTION 'record history native set enrollment is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_history_preserve_source_set(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.record_history_preserve_source_set() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514'; END IF;
 -- The one allowed enrichment is an exact native immutable snapshot after Source seal.
 IF to_jsonb(OLD)->>'metadata_state'='building' AND to_jsonb(NEW)->>'metadata_state'='native-snapshot' THEN
  IF (to_jsonb(NEW)-ARRAY['original_position','metadata_state','snapshot_digest','member_count'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['original_position','metadata_state','snapshot_digest','member_count'])
     OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position) THEN
   RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['original_position','state','next_attempt','gap'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['original_position','state','next_attempt','gap'])
   OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position)
   OR (to_jsonb(OLD)->>'state'='minimized' AND to_jsonb(NEW)->>'state'<>'minimized') THEN
   RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: validate_agent_identity_inventory(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.validate_agent_identity_inventory() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: validate_agent_identity_recovery_inventory(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.validate_agent_identity_recovery_inventory() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i core.agent_identity_recovery_inventory; a access.agent_identity_recovery; r core.receipt;
 expected_receipt bytea; expected_event bytea; c core.agent_identity_history_copy; n integer:=0;
 actual_accounts jsonb; role_count integer; event_count integer;
BEGIN
 SELECT * INTO STRICT i FROM core.agent_identity_recovery_inventory WHERE partition_no=NEW.partition_no
   AND source_route=NEW.source_route AND source_account_id=NEW.source_account_id
   AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id;
 SELECT * INTO STRICT a FROM access.agent_identity_recovery WHERE route=i.source_route
   AND account_id=i.source_account_id AND direction=i.source_direction AND receipt_id=i.source_receipt_id;
 IF i.state<>'sealed' OR i.native_writer_state<>'closed' OR i.producer_version<>1 OR
    i.conversion_coverage<>'native-receipt-outbox/v1' OR cardinality(i.expected_locators)<>2 OR
    i.expected_event_types IS DISTINCT FROM ARRAY['com.rezics.access.account-updated.v1'] OR
    (a.source_partition,a.intent_digest,a.recovery_epoch,a.recovery_position,a.recovery_transaction_id)
      IS DISTINCT FROM (i.partition_no,i.source_digest,i.recovery_epoch,i.recovery_position,i.recovery_transaction_id) THEN
   RAISE EXCEPTION 'Recovery identity serializer inventory incomplete' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.partition p JOIN core.history_family_domain d ON d.singleton
   WHERE p.partition_no=i.partition_no AND p.write_state='active' AND p.epoch=i.recovery_epoch
     AND p.epoch=i.receiver_epoch AND p.position=i.recovery_position AND d.generation=i.domain_generation FOR SHARE OF p,d;
 IF NOT FOUND THEN RAISE EXCEPTION 'Recovery identity native fence changed' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT r FROM core.receipt WHERE partition_no=i.partition_no AND principal_kind=i.native_principal_kind
   AND principal_id=i.native_principal_id AND command_kind=i.native_command_kind
   AND idempotency_key=i.native_receipt_key AND transaction_id=i.recovery_transaction_id
   AND epoch=i.recovery_epoch AND position=i.recovery_position AND request_digest=i.native_request_digest
   AND payload_state='present' AND response='null'::jsonb AND xmin::text=pg_current_xact_id()::text;
 expected_receipt:=decode('0101','hex')||substring(int4send(i.partition_no) from 3 for 2)||decode('01','hex')||
   uuid_send(i.native_principal_id)||int4send(7)||
   substring(int4send(split_part(i.native_receipt_key,'.',2)::integer) from 3 for 2)||
   decode(translate(split_part(i.native_receipt_key,'.',3),'-_','+/')||'=','base64');
 expected_event:=decode('0102','hex')||substring(int4send(i.partition_no) from 3 for 2)||
   int8send(i.recovery_position)||decode('0000','hex');
 IF i.expected_locators[1] IS DISTINCT FROM expected_receipt OR i.expected_locators[2] IS DISTINCT FROM expected_event THEN
   RAISE EXCEPTION 'Recovery identity serializer locator cut changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.outbox WHERE partition_no=i.partition_no AND epoch=i.recovery_epoch
   AND position=i.recovery_position AND event_seq=0 AND event_count=1
   AND type='com.rezics.access.account-updated.v1' AND subject=i.source_account_id::text
   AND data=jsonb_build_object('accountId',i.source_account_id::text) AND payload_state='present'
   AND xmin::text=pg_current_xact_id()::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Recovery identity event is not its actual account wakeup' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT * FROM core.agent_identity_history_copy WHERE partition_no=i.partition_no
   AND source_route=i.source_route AND source_account_id=i.source_account_id AND source_direction=i.source_direction
   AND source_receipt_id=i.source_receipt_id AND source_digest=i.source_digest AND source_epoch=i.recovery_epoch
   AND source_position=i.recovery_position AND source_transaction_id=i.recovery_transaction_id
   ORDER BY artifact_type,locator LIMIT 3 FOR SHARE
 LOOP
   n:=n+1;
   IF n>2 OR c.receiver_epoch<>i.receiver_epoch OR c.domain_generation<>i.domain_generation OR
      NOT c.locator=ANY(i.expected_locators) THEN
     RAISE EXCEPTION 'Recovery identity physical copy cut changed' USING ERRCODE='23514'; END IF;
   SELECT jsonb_agg(jsonb_build_array(account_route,account_id::text,roles) ORDER BY account_route,account_id),count(*)
     INTO actual_accounts,role_count FROM (
       SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
       WHERE partition_no=i.partition_no AND artifact_type=c.artifact_type AND locator=c.locator
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE
     ) scope;
   IF role_count NOT BETWEEN 1 AND 64 OR actual_accounts IS DISTINCT FROM i.expected_accounts OR
      EXISTS (SELECT 1 FROM core.history_locator WHERE partition_no=i.partition_no
        AND artifact_type=c.artifact_type AND locator=c.locator AND minimizer_version<>1) THEN
     RAISE EXCEPTION 'Recovery identity all-role scope changed' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'Recovery identity requires exactly two actual serializers' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: validate_agent_identity_work_source(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.validate_agent_identity_work_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM access.agent_identity_intent i
   WHERE i.route=get_byte(uuid_send((NEW.source_key::jsonb->>1)::uuid),10)*256+
                 get_byte(uuid_send((NEW.source_key::jsonb->>1)::uuid),11)
     AND i.account_id=(NEW.source_key::jsonb->>1)::uuid
     AND i.direction=NEW.source_key::jsonb->>0 AND i.receipt_id=(NEW.source_key::jsonb->>2)::uuid
     AND i.source_partition=NEW.partition_no AND i.source_epoch=(NEW.source->>'epoch')::integer
     AND i.source_position=(NEW.source->>'position')::bigint
     AND i.source_transaction_id=(NEW.source->>'transactionId')::uuid
     AND i.intent_digest=NEW.source->>'digest' AND i.release=NEW.source->>'release'
     AND i.workflow_id=NEW.source->>'workflowId'
     AND i.xmin::text=pg_current_xact_id()::text
 ) OR NEW.source_key<>NEW.source->>'key' OR NEW.partition_no<>(NEW.source->>'partition')::integer THEN
   RAISE EXCEPTION 'SDK association lacks actual original Account source command' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_identity_history_copy; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.agent_identity_history_copy (
    partition_no integer NOT NULL,
    source_route integer NOT NULL,
    source_account_id uuid NOT NULL,
    source_direction text NOT NULL COLLATE pg_catalog."C",
    source_receipt_id uuid NOT NULL,
    source_digest text NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    writer_version integer NOT NULL,
    receiver_epoch integer NOT NULL,
    domain_generation bigint NOT NULL,
    CONSTRAINT agent_identity_history_copy_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text]))),
    CONSTRAINT agent_identity_history_copy_check CHECK ((source_route = ((get_byte(uuid_send(source_account_id), 10) * 256) + get_byte(uuid_send(source_account_id), 11)))),
    CONSTRAINT agent_identity_history_copy_check1 CHECK ((partition_no = (source_route / 16))),
    CONSTRAINT agent_identity_history_copy_domain_generation_check CHECK ((domain_generation > 0)),
    CONSTRAINT agent_identity_history_copy_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT agent_identity_history_copy_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT agent_identity_history_copy_receiver_epoch_check CHECK ((receiver_epoch > 0)),
    CONSTRAINT agent_identity_history_copy_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_history_copy_source_direction_check CHECK ((source_direction = ANY (ARRAY['account-agent.verify'::text, 'account-agent.unverify'::text]))),
    CONSTRAINT agent_identity_history_copy_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT agent_identity_history_copy_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT agent_identity_history_copy_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535))),
    CONSTRAINT agent_identity_history_copy_writer_version_check CHECK ((writer_version = 1))
);


--
-- Name: agent_identity_inventory; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.agent_identity_inventory (
    partition_no integer NOT NULL,
    source_route integer NOT NULL,
    source_account_id uuid NOT NULL,
    source_direction text NOT NULL COLLATE pg_catalog."C",
    source_receipt_id uuid NOT NULL,
    source_digest text NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    producer_version integer NOT NULL,
    conversion_coverage text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    receiver_epoch integer NOT NULL,
    domain_generation bigint NOT NULL,
    native_writer_state text DEFAULT 'closed'::text NOT NULL,
    native_command_kind text NOT NULL,
    native_principal_kind text NOT NULL,
    native_principal_id uuid NOT NULL,
    native_receipt_key text NOT NULL,
    state text DEFAULT 'declared'::text NOT NULL,
    expected_locators bytea[],
    expected_event_types text[],
    CONSTRAINT agent_identity_inventory_check CHECK ((partition_no = (source_route / 16))),
    CONSTRAINT agent_identity_inventory_check1 CHECK ((((state = 'declared'::text) AND (expected_locators IS NULL) AND (expected_event_types IS NULL)) OR ((state = 'sealed'::text) AND ((cardinality(expected_locators) >= 2) AND (cardinality(expected_locators) <= 3)) AND (cardinality(expected_event_types) = (cardinality(expected_locators) - 1))))),
    CONSTRAINT agent_identity_inventory_conversion_coverage_check CHECK ((conversion_coverage = 'native-receipt-outbox/v1'::text)),
    CONSTRAINT agent_identity_inventory_domain_generation_check CHECK ((domain_generation > 0)),
    CONSTRAINT agent_identity_inventory_generation_check CHECK ((generation > 0)),
    CONSTRAINT agent_identity_inventory_native_principal_kind_check CHECK ((native_principal_kind = 'account'::text)),
    CONSTRAINT agent_identity_inventory_native_writer_state_check CHECK ((native_writer_state = 'closed'::text)),
    CONSTRAINT agent_identity_inventory_producer_version_check CHECK ((producer_version = 1)),
    CONSTRAINT agent_identity_inventory_receiver_epoch_check CHECK ((receiver_epoch > 0)),
    CONSTRAINT agent_identity_inventory_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_inventory_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT agent_identity_inventory_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT agent_identity_inventory_state_check CHECK ((state = ANY (ARRAY['declared'::text, 'sealed'::text])))
);


--
-- Name: agent_identity_recovery_inventory; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.agent_identity_recovery_inventory (
    partition_no integer NOT NULL,
    source_route integer NOT NULL,
    source_account_id uuid NOT NULL,
    source_direction text NOT NULL,
    source_receipt_id uuid NOT NULL,
    source_digest text NOT NULL,
    recovery_epoch integer NOT NULL,
    recovery_position bigint NOT NULL,
    recovery_transaction_id uuid CONSTRAINT agent_identity_recovery_invent_recovery_transaction_id_not_null NOT NULL,
    receiver_epoch integer NOT NULL,
    domain_generation bigint NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    producer_version integer DEFAULT 1 NOT NULL,
    conversion_coverage text DEFAULT 'native-receipt-outbox/v1'::text NOT NULL,
    native_writer_state text DEFAULT 'open'::text NOT NULL,
    native_command_kind text NOT NULL,
    native_principal_kind text CONSTRAINT agent_identity_recovery_inventor_native_principal_kind_not_null NOT NULL,
    native_principal_id uuid NOT NULL,
    native_receipt_key text NOT NULL,
    native_request_digest bytea CONSTRAINT agent_identity_recovery_inventor_native_request_digest_not_null NOT NULL,
    expected_accounts jsonb NOT NULL,
    expected_locators bytea[],
    expected_event_types text[],
    state text DEFAULT 'declared'::text NOT NULL,
    CONSTRAINT agent_identity_recovery_inventory_accounts_check CHECK (((jsonb_typeof(expected_accounts) = 'array'::text) AND ((jsonb_array_length(expected_accounts) >= 1) AND (jsonb_array_length(expected_accounts) <= 64)))),
    CONSTRAINT agent_identity_recovery_inventory_command_check CHECK (((native_command_kind = 'access.agent-identity.recover'::text) AND (native_principal_kind = 'account'::text))),
    CONSTRAINT agent_identity_recovery_inventory_cut_check CHECK ((((state = 'declared'::text) AND (expected_locators IS NULL) AND (expected_event_types IS NULL) AND (native_writer_state = 'open'::text)) OR ((state = 'sealed'::text) AND (expected_locators IS NOT NULL) AND (cardinality(expected_locators) = 2) AND (expected_event_types IS NOT NULL) AND (expected_event_types = ARRAY['com.rezics.access.account-updated.v1'::text]) AND (native_writer_state = 'closed'::text)))),
    CONSTRAINT agent_identity_recovery_inventory_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_identity_recovery_inventory_domain_check CHECK (((domain_generation > 0) AND (generation = 1))),
    CONSTRAINT agent_identity_recovery_inventory_epoch_check CHECK (((recovery_epoch > 0) AND (receiver_epoch > 0) AND (recovery_epoch = receiver_epoch))),
    CONSTRAINT agent_identity_recovery_inventory_key_check CHECK ((source_direction = ANY (ARRAY['account-agent.verify'::text, 'account-agent.unverify'::text]))),
    CONSTRAINT agent_identity_recovery_inventory_partition_check CHECK ((partition_no = (source_route / 16))),
    CONSTRAINT agent_identity_recovery_inventory_position_check CHECK ((recovery_position > 0)),
    CONSTRAINT agent_identity_recovery_inventory_producer_check CHECK (((producer_version = 1) AND (conversion_coverage = 'native-receipt-outbox/v1'::text))),
    CONSTRAINT agent_identity_recovery_inventory_request_check CHECK ((octet_length(native_request_digest) = 32)),
    CONSTRAINT agent_identity_recovery_inventory_route_check CHECK ((source_route = ((get_byte(uuid_send(source_account_id), 10) * 256) + get_byte(uuid_send(source_account_id), 11)))),
    CONSTRAINT agent_identity_recovery_inventory_state_check CHECK ((state = ANY (ARRAY['declared'::text, 'sealed'::text]))),
    CONSTRAINT agent_identity_recovery_inventory_writer_check CHECK ((native_writer_state = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: agent_identity_sdk_obligation; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.agent_identity_sdk_obligation (
    partition_no integer NOT NULL,
    source_route integer NOT NULL,
    source_account_id uuid NOT NULL,
    source_direction text NOT NULL COLLATE pg_catalog."C",
    source_receipt_id uuid NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    workflow_id text NOT NULL,
    delivery_key text NOT NULL,
    handoff_partition integer NOT NULL,
    handoff_epoch integer NOT NULL,
    handoff_position bigint NOT NULL,
    handoff_transaction_id uuid NOT NULL,
    handoff_event_type text NOT NULL,
    future_writer_state text DEFAULT 'pending-recording-port'::text NOT NULL,
    CONSTRAINT agent_identity_sdk_obligation_future_writer_state_check CHECK ((future_writer_state = 'pending-recording-port'::text)),
    CONSTRAINT agent_identity_sdk_obligation_generation_check CHECK ((generation > 0)),
    CONSTRAINT agent_identity_sdk_obligation_handoff_epoch_check CHECK ((handoff_epoch > 0)),
    CONSTRAINT agent_identity_sdk_obligation_handoff_partition_check CHECK (((handoff_partition >= 0) AND (handoff_partition <= 4095))),
    CONSTRAINT agent_identity_sdk_obligation_handoff_position_check CHECK ((handoff_position > 0))
);


--
-- Name: agent_identity_work; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.agent_identity_work (
    custody_id uuid NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    source_key text NOT NULL COLLATE pg_catalog."C",
    approval jsonb,
    source jsonb,
    accounts jsonb NOT NULL,
    receiver_epoch integer NOT NULL,
    receiver_generation bigint NOT NULL,
    writer_version integer DEFAULT 1 NOT NULL,
    receiver_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    creation_captured boolean DEFAULT false NOT NULL,
    request_digest bytea,
    sdk_retirement_receipt jsonb,
    history_authority jsonb,
    sdk_readiness jsonb,
    sdk_closure jsonb,
    CONSTRAINT agent_identity_history_closure_pair CHECK (((sdk_closure IS NULL) OR (sdk_retirement_receipt IS NOT NULL))),
    CONSTRAINT agent_identity_history_readiness_pair CHECK (((history_authority IS NULL) = (sdk_readiness IS NULL))),
    CONSTRAINT agent_identity_work_accounts_check CHECK (((jsonb_array_length(accounts) >= 1) AND (jsonb_array_length(accounts) <= 64))),
    CONSTRAINT agent_identity_work_approval_check CHECK ((octet_length((approval)::text) <= 4096)),
    CONSTRAINT agent_identity_work_check CHECK (((approval IS NOT NULL) OR (source IS NOT NULL))),
    CONSTRAINT agent_identity_work_history_authority_check CHECK ((octet_length((history_authority)::text) <= 32768)),
    CONSTRAINT agent_identity_work_receiver_epoch_check CHECK ((receiver_epoch > 0)),
    CONSTRAINT agent_identity_work_receiver_generation_check CHECK ((receiver_generation > 0)),
    CONSTRAINT agent_identity_work_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT agent_identity_work_sdk_closure_check CHECK ((octet_length((sdk_closure)::text) <= 8192)),
    CONSTRAINT agent_identity_work_sdk_readiness_check CHECK ((octet_length((sdk_readiness)::text) <= 65536)),
    CONSTRAINT agent_identity_work_sdk_retirement_receipt_check CHECK (((sdk_retirement_receipt IS NULL) OR ((octet_length((sdk_retirement_receipt)::text) <= 16384) AND (jsonb_typeof(sdk_retirement_receipt) = 'object'::text) AND (jsonb_typeof((sdk_retirement_receipt -> 'fence'::text)) = 'object'::text) AND ((sdk_retirement_receipt -> 'fence'::text) ?& ARRAY['workflowID'::text, 'generation'::text, 'closureID'::text, 'closedAt'::text])))),
    CONSTRAINT agent_identity_work_source_check CHECK ((octet_length((source)::text) <= 4096)),
    CONSTRAINT agent_identity_work_source_key_check CHECK ((octet_length(source_key) <= 256)),
    CONSTRAINT agent_identity_work_workflow_id_check CHECK ((octet_length(workflow_id) <= 256)),
    CONSTRAINT agent_identity_work_writer_version_check CHECK ((writer_version = 1))
);


--
-- Name: agent_identity_work_source; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.agent_identity_work_source (
    partition_no integer NOT NULL,
    source_key text NOT NULL COLLATE pg_catalog."C",
    custody_id uuid NOT NULL,
    source jsonb NOT NULL,
    source_generation bigint NOT NULL,
    writer_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT agent_identity_work_source_source_check CHECK ((octet_length((source)::text) <= 4096)),
    CONSTRAINT agent_identity_work_source_source_generation_check CHECK ((source_generation > 0)),
    CONSTRAINT agent_identity_work_source_source_key_check CHECK ((octet_length(source_key) <= 256)),
    CONSTRAINT agent_identity_work_source_writer_version_check CHECK ((writer_version = 1))
);


--
-- Name: consumer_checkpoint; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.consumer_checkpoint (
    partition_no integer NOT NULL,
    consumer text NOT NULL,
    epoch integer,
    "position" bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consumer_checkpoint_check CHECK (((epoch IS NULL) = ("position" = 0))),
    CONSTRAINT consumer_checkpoint_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT consumer_checkpoint_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT consumer_checkpoint_position_check CHECK (("position" >= 0))
);


--
-- Name: consumer_lag; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.consumer_lag (
    consumer text NOT NULL,
    oldest_pending_at timestamp with time zone,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT consumer_lag_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text))
);


--
-- Name: history_event_consumer; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_event_consumer (
    partition_no integer NOT NULL,
    "position" bigint NOT NULL,
    event_seq integer NOT NULL,
    consumer text NOT NULL COLLATE pg_catalog."C",
    workflow_id text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    CONSTRAINT history_event_consumer_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT history_event_consumer_event_seq_check CHECK (((event_seq >= 0) AND (event_seq <= 999))),
    CONSTRAINT history_event_consumer_position_check CHECK (("position" > 0)),
    CONSTRAINT history_event_consumer_state_check CHECK ((state = ANY (ARRAY['open'::text, 'completed'::text, 'transferred'::text, 'suppressed'::text]))),
    CONSTRAINT history_event_consumer_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: history_family_coverage; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_family_coverage (
    family text NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_version integer NOT NULL,
    barrier_at text NOT NULL,
    definition_digest text NOT NULL,
    domain_generation bigint NOT NULL,
    fence_revision bigint NOT NULL,
    partition_cursor integer DEFAULT '-1'::integer NOT NULL,
    current_partition integer,
    artifact_type text COLLATE pg_catalog."C",
    locator bytea,
    phase text DEFAULT 'scan'::text NOT NULL,
    gap text,
    proof_id uuid,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT history_family_coverage_barrier_version_check CHECK ((barrier_version > 0)),
    CONSTRAINT history_family_coverage_check CHECK (((artifact_type IS NULL) = (locator IS NULL))),
    CONSTRAINT history_family_coverage_check1 CHECK (((phase = 'complete'::text) = (proof_id IS NOT NULL))),
    CONSTRAINT history_family_coverage_check2 CHECK (((phase = 'pending'::text) = (gap IS NOT NULL))),
    CONSTRAINT history_family_coverage_current_partition_check CHECK (((current_partition >= 0) AND (current_partition <= 4095))),
    CONSTRAINT history_family_coverage_gap_check CHECK ((octet_length(gap) <= 256)),
    CONSTRAINT history_family_coverage_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT history_family_coverage_partition_cursor_check CHECK (((partition_cursor >= '-1'::integer) AND (partition_cursor <= 4095))),
    CONSTRAINT history_family_coverage_phase_check CHECK ((phase = ANY (ARRAY['scan'::text, 'pending'::text, 'complete'::text])))
);


--
-- Name: history_family_definition; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_family_definition (
    family text NOT NULL,
    version integer NOT NULL,
    digest text NOT NULL,
    registry_digest text NOT NULL,
    sources jsonb NOT NULL,
    admit_cursor uuid,
    admission_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT history_family_definition_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT history_family_definition_family_check CHECK ((family = ANY (ARRAY['access'::text, 'commerce'::text, 'community'::text, 'content'::text, 'library'::text, 'rating'::text, 'semantic'::text, 'zones'::text, 'imports'::text]))),
    CONSTRAINT history_family_definition_registry_digest_check CHECK ((registry_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT history_family_definition_sources_check CHECK (((jsonb_typeof(sources) = 'array'::text) AND ((jsonb_array_length(sources) >= 1) AND (jsonb_array_length(sources) <= 100)))),
    CONSTRAINT history_family_definition_version_check CHECK ((version > 0))
);


--
-- Name: history_family_domain; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_family_domain (
    singleton boolean DEFAULT true NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    CONSTRAINT history_family_domain_generation_check CHECK ((generation > 0)),
    CONSTRAINT history_family_domain_singleton_check CHECK (singleton)
);


--
-- Name: history_family_enrollment; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_family_enrollment (
    family text NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    partition_no integer NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    producer text NOT NULL,
    producer_version integer NOT NULL,
    definition_digest text NOT NULL,
    barrier_version integer NOT NULL,
    barrier_at text NOT NULL,
    partition_epoch integer NOT NULL,
    source_cut bytea NOT NULL,
    CONSTRAINT history_family_enrollment_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT history_family_enrollment_barrier_version_check CHECK ((barrier_version > 0)),
    CONSTRAINT history_family_enrollment_definition_digest_check CHECK ((definition_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT history_family_enrollment_partition_epoch_check CHECK ((partition_epoch > 0)),
    CONSTRAINT history_family_enrollment_producer_check CHECK ((producer ~ '^[a-z][a-z0-9_.-]{0,95}$'::text)),
    CONSTRAINT history_family_enrollment_producer_version_check CHECK ((producer_version > 0)),
    CONSTRAINT history_family_enrollment_source_cut_check CHECK (((octet_length(source_cut) >= 1) AND (octet_length(source_cut) <= 256)))
);


--
-- Name: history_family_fence; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_family_fence (
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT history_family_fence_revision_check CHECK ((revision > 0))
);


--
-- Name: history_family_watch; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_family_watch (
    partition_no integer NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    source_key jsonb NOT NULL,
    CONSTRAINT history_family_watch_source_key_check CHECK ((octet_length((source_key)::text) <= 1024))
);


--
-- Name: history_locator; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_locator (
    partition_no integer NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    roles integer NOT NULL,
    minimizer_version integer NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    proof_barrier uuid,
    CONSTRAINT history_locator_account_route_check CHECK (((account_route >= 0) AND (account_route <= 65535))),
    CONSTRAINT history_locator_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT history_locator_check CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT history_locator_check1 CHECK ((((state = 'pending'::text) AND (proof_barrier IS NULL)) OR ((state = 'minimized'::text) AND (proof_barrier IS NOT NULL) AND (proof_barrier = account_id)))),
    CONSTRAINT history_locator_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT history_locator_minimizer_version_check CHECK ((minimizer_version = 1)),
    CONSTRAINT history_locator_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_locator_roles_check CHECK (((roles >= 1) AND (roles <= 262143))),
    CONSTRAINT history_locator_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text])))
);


--
-- Name: history_progress; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_progress (
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id uuid NOT NULL,
    store_kind core.history_store_kind NOT NULL,
    partition_no integer NOT NULL,
    partition_epoch integer NOT NULL,
    artifact_type text COLLATE pg_catalog."C",
    locator bytea,
    state text DEFAULT 'pending'::text NOT NULL,
    proof text,
    coverage_gap text,
    applicable boolean DEFAULT false NOT NULL,
    CONSTRAINT history_progress_account_route_check CHECK (((account_route >= 0) AND (account_route <= 65535))),
    CONSTRAINT history_progress_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT history_progress_check CHECK ((barrier_id = account_id)),
    CONSTRAINT history_progress_check1 CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT history_progress_check2 CHECK (((artifact_type IS NULL) = (locator IS NULL))),
    CONSTRAINT history_progress_check3 CHECK (((state = 'pending'::text) = (proof IS NULL))),
    CONSTRAINT history_progress_coverage_gap_check CHECK ((octet_length(coverage_gap) <= 2048)),
    CONSTRAINT history_progress_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT history_progress_partition_epoch_check CHECK ((partition_epoch > 0)),
    CONSTRAINT history_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_progress_proof_check CHECK ((proof = ANY (ARRAY['erased'::text, 'none'::text]))),
    CONSTRAINT history_progress_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'complete'::text])))
);


--
-- Name: history_receiving_proof; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_receiving_proof (
    partition_no integer NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    barrier_version integer NOT NULL,
    barrier_at text NOT NULL,
    partition_epoch integer NOT NULL,
    role_digest bytea NOT NULL,
    CONSTRAINT history_receiving_proof_barrier_version_check CHECK ((barrier_version > 0)),
    CONSTRAINT history_receiving_proof_partition_epoch_check CHECK ((partition_epoch > 0)),
    CONSTRAINT history_receiving_proof_role_digest_check CHECK ((octet_length(role_digest) = 32))
);


--
-- Name: history_registry; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_registry (
    singleton boolean DEFAULT true NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    digest text NOT NULL,
    gaps jsonb NOT NULL,
    CONSTRAINT history_registry_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT history_registry_gaps_check CHECK (((jsonb_typeof(gaps) = 'array'::text) AND (octet_length((gaps)::text) <= 4096))),
    CONSTRAINT history_registry_generation_check CHECK ((generation > 0)),
    CONSTRAINT history_registry_singleton_check CHECK (singleton)
);


--
-- Name: history_seal; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_seal (
    partition_no integer NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id uuid,
    phase text DEFAULT 'open'::text NOT NULL,
    CONSTRAINT history_seal_account_route_check CHECK (((account_route >= 0) AND (account_route <= 65535))),
    CONSTRAINT history_seal_check CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT history_seal_check1 CHECK ((((phase = 'open'::text) AND (barrier_id IS NULL)) OR ((phase <> 'open'::text) AND (barrier_id IS NOT NULL) AND (barrier_id = account_id)))),
    CONSTRAINT history_seal_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_seal_phase_check CHECK ((phase = ANY (ARRAY['open'::text, 'sealed'::text, 'complete'::text])))
);


--
-- Name: history_work; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_work (
    partition_no integer NOT NULL,
    work_id uuid NOT NULL,
    request_digest bytea NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    owner_ready boolean DEFAULT false NOT NULL,
    retired_at timestamp with time zone,
    owner text,
    request jsonb,
    scope jsonb,
    source_partition integer,
    source_transaction uuid,
    admitted boolean DEFAULT false NOT NULL,
    absence_verified boolean DEFAULT false NOT NULL,
    CONSTRAINT history_work_check CHECK (((state <> 'ready'::text) OR owner_ready)),
    CONSTRAINT history_work_check1 CHECK (((state = 'retired'::text) = (retired_at IS NOT NULL))),
    CONSTRAINT history_work_owner_check CHECK ((owner ~ '^[a-z][a-z0-9_.-]{0,95}$'::text)),
    CONSTRAINT history_work_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_work_request_check CHECK ((octet_length((request)::text) <= 65536)),
    CONSTRAINT history_work_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT history_work_scope_check CHECK ((octet_length((scope)::text) <= 16384)),
    CONSTRAINT history_work_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095))),
    CONSTRAINT history_work_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'retired'::text])))
);


--
-- Name: identity_fx_original; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.identity_fx_original (
    original_id uuid NOT NULL,
    partition_no integer NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    event_seq integer NOT NULL,
    effect text NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    binding jsonb NOT NULL,
    deadline bigint NOT NULL,
    allowance bigint[] NOT NULL,
    spent bigint[] NOT NULL,
    CONSTRAINT identity_fx_original_allowance_check CHECK (core.identity_original_vector_valid(allowance)),
    CONSTRAINT identity_fx_original_binding_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND (octet_length((binding)::text) <= 32768))),
    CONSTRAINT identity_fx_original_check CHECK (((spent[1] <= allowance[1]) AND (spent[2] <= allowance[2]) AND (spent[3] <= allowance[3]) AND (spent[4] <= allowance[4]) AND (spent[5] <= allowance[5]) AND (spent[6] <= allowance[6]) AND (spent[7] <= allowance[7]) AND (spent[8] <= allowance[8]))),
    CONSTRAINT identity_fx_original_deadline_check CHECK (((deadline >= 1) AND (deadline <= '9007199254740991'::bigint))),
    CONSTRAINT identity_fx_original_effect_check CHECK ((effect = 'agent_verification_reversal'::text)),
    CONSTRAINT identity_fx_original_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT identity_fx_original_event_seq_check CHECK (((event_seq >= 0) AND (event_seq <= 999))),
    CONSTRAINT identity_fx_original_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_fx_original_position_check CHECK (("position" > 0)),
    CONSTRAINT identity_fx_original_spent_check CHECK (core.identity_original_vector_valid(spent)),
    CONSTRAINT identity_fx_original_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: identity_fx_receiving; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.identity_fx_receiving (
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    original_id uuid NOT NULL,
    binding jsonb NOT NULL,
    receiver_epoch integer NOT NULL,
    receiver_generation bigint NOT NULL,
    deadline bigint NOT NULL,
    writer_state text DEFAULT 'pending-physical-owner'::text NOT NULL,
    allowance bigint[] NOT NULL,
    spent bigint[] NOT NULL,
    CONSTRAINT identity_fx_receiving_allowance_check CHECK (core.identity_original_vector_valid(allowance)),
    CONSTRAINT identity_fx_receiving_binding_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND (octet_length((binding)::text) <= 32768))),
    CONSTRAINT identity_fx_receiving_check CHECK (((spent[1] <= allowance[1]) AND (spent[2] <= allowance[2]) AND (spent[3] <= allowance[3]) AND (spent[4] <= allowance[4]) AND (spent[5] <= allowance[5]) AND (spent[6] <= allowance[6]) AND (spent[7] <= allowance[7]) AND (spent[8] <= allowance[8]))),
    CONSTRAINT identity_fx_receiving_deadline_check CHECK (((deadline >= 1) AND (deadline <= '9007199254740991'::bigint))),
    CONSTRAINT identity_fx_receiving_receiver_epoch_check CHECK ((receiver_epoch > 0)),
    CONSTRAINT identity_fx_receiving_receiver_generation_check CHECK ((receiver_generation > 0)),
    CONSTRAINT identity_fx_receiving_spent_check CHECK (core.identity_original_vector_valid(spent)),
    CONSTRAINT identity_fx_receiving_workflow_id_check CHECK ((octet_length(workflow_id) <= 256)),
    CONSTRAINT identity_fx_receiving_writer_state_check CHECK ((writer_state = 'pending-physical-owner'::text))
);


--
-- Name: identity_history_allocation; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.identity_history_allocation (
    original_id uuid NOT NULL,
    local_work bigint[] NOT NULL,
    source_work bigint[],
    library_work bigint[],
    transfer_work bigint[] NOT NULL,
    parent_work bigint[] NOT NULL,
    local_entered boolean DEFAULT false NOT NULL,
    child_entered boolean DEFAULT false NOT NULL,
    child_ended boolean DEFAULT false NOT NULL,
    next_binding jsonb,
    CONSTRAINT identity_history_allocation_check CHECK ((parent_work = core.identity_original_sum(local_work, source_work, library_work, transfer_work))),
    CONSTRAINT identity_history_allocation_check1 CHECK (((NOT child_entered) OR (local_entered AND (source_work IS NOT NULL) AND (library_work IS NOT NULL)))),
    CONSTRAINT identity_history_allocation_check2 CHECK (((NOT child_ended) OR child_entered)),
    CONSTRAINT identity_history_allocation_check3 CHECK (((next_binding IS NULL) OR local_entered)),
    CONSTRAINT identity_history_allocation_library_work_check CHECK (((library_work IS NULL) OR core.identity_original_vector_valid(library_work))),
    CONSTRAINT identity_history_allocation_local_work_check CHECK (core.identity_original_vector_valid(local_work)),
    CONSTRAINT identity_history_allocation_next_binding_check CHECK (((next_binding IS NULL) OR ((jsonb_typeof(next_binding) = 'object'::text) AND (octet_length((next_binding)::text) <= 2048)))),
    CONSTRAINT identity_history_allocation_parent_work_check CHECK (core.identity_original_vector_valid(parent_work)),
    CONSTRAINT identity_history_allocation_source_work_check CHECK (((source_work IS NULL) OR core.identity_original_vector_valid(source_work))),
    CONSTRAINT identity_history_allocation_transfer_work_check CHECK (core.identity_original_vector_valid(transfer_work))
);


--
-- Name: identity_history_original; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.identity_history_original (
    original_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    job_id uuid NOT NULL,
    binding jsonb NOT NULL,
    deadline bigint NOT NULL,
    allowance bigint[] NOT NULL,
    spent bigint[] NOT NULL,
    dispatched boolean DEFAULT false NOT NULL,
    advanced boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_history_original_allowance_check CHECK (core.identity_original_vector_valid(allowance)),
    CONSTRAINT identity_history_original_binding_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND (octet_length((binding)::text) <= 2048))),
    CONSTRAINT identity_history_original_check CHECK (((binding ->> 'job_id'::text) = (job_id)::text)),
    CONSTRAINT identity_history_original_check1 CHECK (((NOT advanced) OR dispatched)),
    CONSTRAINT identity_history_original_check2 CHECK (((spent[1] <= allowance[1]) AND (spent[2] <= allowance[2]) AND (spent[3] <= allowance[3]) AND (spent[4] <= allowance[4]) AND (spent[5] <= allowance[5]) AND (spent[6] <= allowance[6]) AND (spent[7] <= allowance[7]) AND (spent[8] <= allowance[8]))),
    CONSTRAINT identity_history_original_deadline_check CHECK (((deadline >= 1) AND (deadline <= '9007199254740991'::bigint))),
    CONSTRAINT identity_history_original_spent_check CHECK (core.identity_original_vector_valid(spent))
);


--
-- Name: identity_history_original_ordinal_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.identity_history_original ALTER COLUMN ordinal ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.identity_history_original_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operational_work_episode; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.operational_work_episode (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    custody_id uuid NOT NULL,
    CONSTRAINT operational_work_episode_check CHECK ((((route >= 0) AND (route <= 65535)) AND (partition_no = (route >> 4)))),
    CONSTRAINT operational_work_episode_check1 CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT operational_work_episode_check2 CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT operational_work_episode_check3 CHECK ((route = ((get_byte(uuid_send(episode_id), 10) * 256) + get_byte(uuid_send(episode_id), 11))))
);


--
-- Name: operational_work_head; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.operational_work_head (
    partition_no integer NOT NULL,
    domain text DEFAULT 'operational-work/v1'::text NOT NULL,
    epoch integer NOT NULL,
    generation bigint NOT NULL,
    "position" bigint NOT NULL,
    custody_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    request_digest bytea NOT NULL,
    deadline bigint NOT NULL,
    CONSTRAINT operational_work_head_deadline_check CHECK ((deadline > 0)),
    CONSTRAINT operational_work_head_domain_check CHECK ((domain = 'operational-work/v1'::text)),
    CONSTRAINT operational_work_head_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT operational_work_head_generation_check CHECK ((generation > 0)),
    CONSTRAINT operational_work_head_position_check CHECK (("position" > 0)),
    CONSTRAINT operational_work_head_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT operational_work_head_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: operational_work_mapping; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.operational_work_mapping (
    partition_no integer DEFAULT 0 NOT NULL,
    custody_id uuid NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    source_partition integer NOT NULL,
    source_transaction uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint,
    log_gap text DEFAULT 'operational-work-original-log-position-unavailable'::text,
    source_generation bigint NOT NULL,
    request_digest bytea NOT NULL,
    source jsonb NOT NULL,
    receiver_epoch integer NOT NULL,
    receiver_generation bigint NOT NULL,
    sdk_writer jsonb NOT NULL,
    source_domain text DEFAULT 'legacy-unpositioned'::text NOT NULL,
    CONSTRAINT operational_work_mapping_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT operational_work_mapping_position_domain CHECK ((((source_domain = 'legacy-unpositioned'::text) AND (source_position IS NULL) AND (NOT (log_gap IS DISTINCT FROM 'operational-work-original-log-position-unavailable'::text))) OR ((source_domain = 'operational-work/v1'::text) AND (source_position IS NOT NULL) AND (source_position > 0) AND (log_gap IS NULL)))),
    CONSTRAINT operational_work_mapping_receiver_epoch_check CHECK ((receiver_epoch > 0)),
    CONSTRAINT operational_work_mapping_receiver_generation_check CHECK ((receiver_generation > 0)),
    CONSTRAINT operational_work_mapping_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT operational_work_mapping_sdk_writer_check CHECK ((octet_length((sdk_writer)::text) <= 1024)),
    CONSTRAINT operational_work_mapping_source_check CHECK ((octet_length((source)::text) <= 278528)),
    CONSTRAINT operational_work_mapping_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT operational_work_mapping_source_generation_check CHECK ((source_generation > 0)),
    CONSTRAINT operational_work_mapping_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095))),
    CONSTRAINT operational_work_mapping_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: operational_work_original; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.operational_work_original (
    partition_no integer NOT NULL,
    custody_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    request_digest bytea NOT NULL,
    binding jsonb NOT NULL,
    intent jsonb NOT NULL,
    scope jsonb NOT NULL,
    operation_kind text NOT NULL,
    operation_mode text NOT NULL,
    operation_accounts jsonb NOT NULL,
    deadline bigint NOT NULL,
    source_generation bigint NOT NULL,
    source_epoch integer,
    source_position bigint,
    sealed boolean DEFAULT false NOT NULL,
    log_gap text DEFAULT 'operational-work-original-log-position-unavailable'::text,
    creation_captured boolean NOT NULL,
    sdk_writer jsonb NOT NULL,
    sdk_creator text,
    sdk_input_digest bytea NOT NULL,
    source_domain text DEFAULT 'legacy-unpositioned'::text NOT NULL,
    CONSTRAINT operational_work_original_binding_check CHECK ((octet_length((binding)::text) <= 262144)),
    CONSTRAINT operational_work_original_check CHECK (((source_epoch IS NOT NULL) = sealed)),
    CONSTRAINT operational_work_original_check1 CHECK (((NOT creation_captured) OR (sdk_creator IS NOT NULL))),
    CONSTRAINT operational_work_original_check2 CHECK ((partition_no = (((binding ->> 'route'::text))::integer >> 4))),
    CONSTRAINT operational_work_original_check3 CHECK ((operation_accounts = jsonb_build_array((binding ->> 'ownerAccountId'::text)))),
    CONSTRAINT operational_work_original_deadline_check CHECK ((deadline > 0)),
    CONSTRAINT operational_work_original_intent_check CHECK ((octet_length((intent)::text) <= 8192)),
    CONSTRAINT operational_work_original_operation_accounts_check CHECK ((jsonb_array_length(operation_accounts) = 1)),
    CONSTRAINT operational_work_original_operation_kind_check CHECK ((operation_kind = 'library.membersPreparation'::text)),
    CONSTRAINT operational_work_original_operation_mode_check CHECK ((operation_mode = 'request'::text)),
    CONSTRAINT operational_work_original_position_domain CHECK ((((source_domain = 'legacy-unpositioned'::text) AND (source_position IS NULL) AND (NOT (log_gap IS DISTINCT FROM 'operational-work-original-log-position-unavailable'::text))) OR ((source_domain = 'operational-work/v1'::text) AND (source_position IS NOT NULL) AND (source_position > 0) AND (log_gap IS NULL)))),
    CONSTRAINT operational_work_original_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT operational_work_original_scope_check CHECK (((octet_length((scope)::text) <= 4096) AND ((jsonb_array_length((scope -> 'accounts'::text)) >= 1) AND (jsonb_array_length((scope -> 'accounts'::text)) <= 8)))),
    CONSTRAINT operational_work_original_sdk_creator_check CHECK ((octet_length(sdk_creator) <= 256)),
    CONSTRAINT operational_work_original_sdk_input_digest_check CHECK ((octet_length(sdk_input_digest) = 32)),
    CONSTRAINT operational_work_original_sdk_writer_check CHECK ((octet_length((sdk_writer)::text) <= 1024)),
    CONSTRAINT operational_work_original_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT operational_work_original_source_generation_check CHECK ((source_generation > 0)),
    CONSTRAINT operational_work_original_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: operational_work_selected_continuation; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.operational_work_selected_continuation (
    partition_no integer NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    custody_id uuid NOT NULL,
    parent_workflow_id text CONSTRAINT operational_work_selected_continuat_parent_workflow_id_not_null NOT NULL COLLATE pg_catalog."C",
    parent_function_id integer CONSTRAINT operational_work_selected_continuat_parent_function_id_not_null NOT NULL,
    route integer NOT NULL,
    owner_account_id uuid CONSTRAINT operational_work_selected_continuatio_owner_account_id_not_null NOT NULL,
    collection_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    sdk_input_digest bytea CONSTRAINT operational_work_selected_continuatio_sdk_input_digest_not_null NOT NULL,
    sdk_creator text NOT NULL,
    CONSTRAINT operational_work_selected_continuation_sdk_creator_check CHECK ((octet_length(sdk_creator) <= 256)),
    CONSTRAINT operational_work_selected_continuation_sdk_input_digest_check CHECK ((octet_length(sdk_input_digest) = 32)),
    CONSTRAINT operational_work_selected_continuation_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: operational_work_selection; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.operational_work_selection (
    partition_no integer NOT NULL,
    workflow_id text NOT NULL COLLATE pg_catalog."C",
    function_id integer NOT NULL,
    custody_id uuid NOT NULL,
    route integer NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    attempt_generation bigint NOT NULL,
    restore_generation uuid NOT NULL,
    deadline bigint NOT NULL,
    original_digest bytea NOT NULL,
    selected_tuple jsonb NOT NULL,
    result jsonb,
    CONSTRAINT operational_work_selection_attempt_generation_check CHECK ((attempt_generation > 0)),
    CONSTRAINT operational_work_selection_check CHECK ((((route >= 0) AND (route <= 65535)) AND (partition_no = (route >> 4)))),
    CONSTRAINT operational_work_selection_deadline_check CHECK ((deadline > 0)),
    CONSTRAINT operational_work_selection_function_id_check CHECK (((function_id >= 0) AND (function_id <= 63))),
    CONSTRAINT operational_work_selection_original_digest_check CHECK ((octet_length(original_digest) = 32)),
    CONSTRAINT operational_work_selection_result_check CHECK (((result IS NULL) OR ((octet_length((result)::text) <= 4096) AND ((result ->> 'kind'::text) = ANY (ARRAY['complete'::text, 'continue'::text, 'failure'::text, 'obsolete'::text]))))),
    CONSTRAINT operational_work_selection_selected_tuple_check CHECK ((octet_length((selected_tuple)::text) <= 2097152)),
    CONSTRAINT operational_work_selection_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: outbox; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.outbox (
    partition_no integer NOT NULL,
    "position" bigint NOT NULL,
    event_seq integer NOT NULL,
    event_count integer NOT NULL,
    epoch integer NOT NULL,
    id uuid NOT NULL,
    type text NOT NULL,
    subject text,
    data jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    payload_state text DEFAULT 'present'::text NOT NULL,
    CONSTRAINT outbox_check CHECK (((event_seq >= 0) AND (event_seq < event_count))),
    CONSTRAINT outbox_event_count_check CHECK ((event_count > 0)),
    CONSTRAINT outbox_minimized_payload CHECK (((payload_state <> 'minimized'::text) OR ((data = '{}'::jsonb) AND (subject IS NULL)))),
    CONSTRAINT outbox_payload_state_check CHECK ((payload_state = ANY (ARRAY['present'::text, 'minimized'::text]))),
    CONSTRAINT outbox_position_check CHECK (("position" > 0))
);


--
-- Name: partition; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.partition (
    partition_no integer NOT NULL,
    node text NOT NULL,
    write_state text DEFAULT 'active'::text NOT NULL,
    moved_to text,
    epoch integer DEFAULT 1 NOT NULL,
    "position" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT partition_check CHECK (((write_state = 'moved'::text) = (moved_to IS NOT NULL))),
    CONSTRAINT partition_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT partition_partition_no_check CHECK ((partition_no >= 0)),
    CONSTRAINT partition_position_check CHECK (("position" >= 0)),
    CONSTRAINT partition_write_state_check CHECK ((write_state = ANY (ARRAY['active'::text, 'fenced'::text, 'moved'::text])))
);


--
-- Name: preference_history_job; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.preference_history_job (
    job_id uuid NOT NULL,
    partition_no integer NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    cursor bytea,
    scan_partition integer DEFAULT 0 NOT NULL,
    scan_type text COLLATE pg_catalog."C",
    scan_locator bytea,
    phase text DEFAULT 'scan'::text NOT NULL,
    applicable boolean DEFAULT false NOT NULL,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    gap text,
    barrier_version integer,
    barrier_at text,
    registry_digest text,
    verify_partition integer DEFAULT 0 NOT NULL,
    registry_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT history_job_cursor CHECK (((scan_type IS NULL) = (scan_locator IS NULL))),
    CONSTRAINT preference_history_job_check CHECK ((barrier_id = account_id)),
    CONSTRAINT preference_history_job_check1 CHECK ((partition_no = (account_route >> 4))),
    CONSTRAINT preference_history_job_cursor_check CHECK (((octet_length(cursor) >= 1) AND (octet_length(cursor) <= 256))),
    CONSTRAINT preference_history_job_gap_check CHECK ((octet_length(gap) <= 2048)),
    CONSTRAINT preference_history_job_phase_check CHECK ((phase = ANY (ARRAY['scan'::text, 'verify'::text, 'pending'::text, 'complete'::text]))),
    CONSTRAINT preference_history_job_scan_locator_check CHECK (((octet_length(scan_locator) >= 1) AND (octet_length(scan_locator) <= 256))),
    CONSTRAINT preference_history_job_scan_partition_check CHECK (((scan_partition >= 0) AND (scan_partition <= 4096))),
    CONSTRAINT preference_history_job_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'covered-pending'::text]))),
    CONSTRAINT preference_history_job_verify_partition_check CHECK (((verify_partition >= 0) AND (verify_partition <= 4096)))
);


--
-- Name: receipt; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.receipt (
    partition_no integer NOT NULL,
    principal_id uuid CONSTRAINT receipt_actor_account_id_not_null NOT NULL,
    command_kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest bytea NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    principal_kind text NOT NULL,
    actor_account_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (principal_kind = 'account'::text) THEN principal_id
    ELSE NULL::uuid
END) STORED,
    payload_state text DEFAULT 'present'::text NOT NULL,
    CONSTRAINT receipt_anonymous_key_check CHECK (((principal_kind <> 'anonymous'::text) OR (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) OR (idempotency_key ~ '^rk1\.(0|[1-9][0-9]{0,2})\.[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT receipt_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT receipt_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255))),
    CONSTRAINT receipt_minimized_response CHECK (((payload_state <> 'minimized'::text) OR (response = 'null'::jsonb))),
    CONSTRAINT receipt_payload_state_check CHECK ((payload_state = ANY (ARRAY['present'::text, 'minimized'::text]))),
    CONSTRAINT receipt_position_check CHECK (("position" >= 0)),
    CONSTRAINT receipt_principal_check CHECK ((((principal_kind = 'account'::text) AND (principal_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((principal_kind = 'anonymous'::text) AND (principal_id = '00000000-0000-0000-0000-000000000000'::uuid)))),
    CONSTRAINT receipt_request_digest_check CHECK ((octet_length(request_digest) = 32))
);


--
-- Name: record_history_locator; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.record_history_locator (
    source_key text NOT NULL COLLATE pg_catalog."C",
    partition_no integer NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    original_transaction uuid NOT NULL,
    original_position bigint,
    producer_version integer NOT NULL,
    coverage text DEFAULT 'partial'::text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    next_attempt timestamp with time zone DEFAULT now() NOT NULL,
    gap text,
    CONSTRAINT record_history_locator_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT record_history_locator_coverage_check CHECK ((coverage = 'partial'::text)),
    CONSTRAINT record_history_locator_gap_check CHECK ((octet_length(gap) <= 256)),
    CONSTRAINT record_history_locator_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT record_history_locator_original_position_check CHECK ((original_position >= 0)),
    CONSTRAINT record_history_locator_producer_version_check CHECK ((producer_version = 1)),
    CONSTRAINT record_history_locator_source_key_check CHECK (((octet_length(source_key) >= 1) AND (octet_length(source_key) <= 256))),
    CONSTRAINT record_history_locator_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text])))
);


--
-- Name: record_history_purge; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.record_history_purge (
    source_key text NOT NULL COLLATE pg_catalog."C",
    deletion_generation uuid NOT NULL,
    partition_no integer NOT NULL,
    subject_id uuid,
    candidate_id uuid,
    revision integer,
    document_id uuid,
    gap text DEFAULT 'record-original-producer-coverage-unsealed'::text NOT NULL,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    reference_kind text DEFAULT 'contribution'::text NOT NULL,
    resource_id uuid,
    set_frontier bytea,
    set_inventory_sealed boolean DEFAULT false NOT NULL,
    native_set_frontier text,
    native_set_index_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT record_history_purge_gap_check CHECK ((octet_length(gap) <= 256)),
    CONSTRAINT record_history_purge_reference CHECK ((((reference_kind = 'contribution'::text) AND (resource_id IS NULL) AND (subject_id IS NOT NULL) AND (candidate_id IS NOT NULL) AND (revision IS NOT NULL) AND (revision > 0)) OR ((reference_kind = ANY (ARRAY['context'::text, 'zone'::text])) AND (resource_id IS NOT NULL) AND (subject_id IS NULL) AND (candidate_id IS NULL) AND (revision IS NULL) AND (document_id IS NULL)))),
    CONSTRAINT record_history_purge_reference_kind_check CHECK ((reference_kind = ANY (ARRAY['contribution'::text, 'context'::text, 'zone'::text]))),
    CONSTRAINT record_history_purge_revision_check CHECK ((revision > 0)),
    CONSTRAINT record_history_purge_set_frontier_check CHECK (((set_frontier IS NULL) OR ((octet_length(set_frontier) >= 1) AND (octet_length(set_frontier) <= 256))))
);


--
-- Name: record_history_purge_set; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.record_history_purge_set (
    source_key text NOT NULL COLLATE pg_catalog."C",
    deletion_generation uuid NOT NULL,
    source_partition integer NOT NULL,
    set_locator bytea NOT NULL,
    set_revision bytea NOT NULL,
    original_transaction uuid NOT NULL,
    member_count integer NOT NULL,
    next_attempt timestamp with time zone DEFAULT now() NOT NULL,
    native_revision integer,
    snapshot_digest text,
    CONSTRAINT record_history_purge_set_check CHECK (((native_revision IS NULL) = (snapshot_digest IS NULL))),
    CONSTRAINT record_history_purge_set_member_count_check CHECK (((member_count >= 0) AND (member_count <= 512))),
    CONSTRAINT record_history_purge_set_native_revision_check CHECK ((native_revision > 0)),
    CONSTRAINT record_history_purge_set_snapshot_digest_check CHECK ((snapshot_digest <> ''::text))
);


--
-- Name: record_history_source_set; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.record_history_source_set (
    source_partition integer NOT NULL,
    set_locator bytea NOT NULL,
    set_revision bytea NOT NULL,
    original_transaction uuid NOT NULL,
    original_position bigint,
    member_count integer,
    producer_version integer NOT NULL,
    native_revision integer,
    snapshot_digest text,
    metadata_state text DEFAULT 'legacy'::text NOT NULL,
    CONSTRAINT record_history_source_set_check CHECK ((((metadata_state = 'legacy'::text) AND (native_revision IS NULL) AND (snapshot_digest IS NULL) AND (member_count IS NOT NULL)) OR ((metadata_state = 'building'::text) AND (native_revision IS NOT NULL) AND (snapshot_digest IS NULL) AND (member_count IS NULL)) OR ((metadata_state = 'native-snapshot'::text) AND (native_revision IS NOT NULL) AND (snapshot_digest IS NOT NULL) AND (member_count IS NOT NULL)))),
    CONSTRAINT record_history_source_set_member_count_check CHECK (((member_count >= 0) AND (member_count <= 512))),
    CONSTRAINT record_history_source_set_metadata_state_check CHECK ((metadata_state = ANY (ARRAY['legacy'::text, 'building'::text, 'native-snapshot'::text]))),
    CONSTRAINT record_history_source_set_native_revision_check CHECK ((native_revision > 0)),
    CONSTRAINT record_history_source_set_original_position_check CHECK ((original_position >= 0)),
    CONSTRAINT record_history_source_set_producer_version_check CHECK ((producer_version = 1)),
    CONSTRAINT record_history_source_set_set_locator_check CHECK (((octet_length(set_locator) >= 1) AND (octet_length(set_locator) <= 256))),
    CONSTRAINT record_history_source_set_set_revision_check CHECK (((octet_length(set_revision) >= 1) AND (octet_length(set_revision) <= 256))),
    CONSTRAINT record_history_source_set_snapshot_digest_check CHECK ((snapshot_digest <> ''::text))
);


--
-- Name: record_history_source_set_copy; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.record_history_source_set_copy (
    source_partition integer NOT NULL,
    set_locator bytea NOT NULL,
    set_revision bytea NOT NULL,
    partition_no integer NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    original_transaction uuid NOT NULL,
    original_position bigint,
    producer_version integer NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    next_attempt timestamp with time zone DEFAULT now() NOT NULL,
    gap text,
    CONSTRAINT record_history_source_set_copy_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT record_history_source_set_copy_gap_check CHECK ((octet_length(gap) <= 256)),
    CONSTRAINT record_history_source_set_copy_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT record_history_source_set_copy_original_position_check CHECK ((original_position >= 0)),
    CONSTRAINT record_history_source_set_copy_producer_version_check CHECK ((producer_version = 1)),
    CONSTRAINT record_history_source_set_copy_set_locator_check CHECK (((octet_length(set_locator) >= 1) AND (octet_length(set_locator) <= 256))),
    CONSTRAINT record_history_source_set_copy_set_revision_check CHECK (((octet_length(set_revision) >= 1) AND (octet_length(set_revision) <= 256))),
    CONSTRAINT record_history_source_set_copy_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text])))
);


--
-- Name: write_basis; Type: TABLE; Schema: editorial; Owner: -
--

CREATE TABLE editorial.write_basis (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    principal_id uuid CONSTRAINT write_basis_actor_account_id_not_null NOT NULL,
    client_id text,
    requested_by text,
    recorded_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    principal_kind text NOT NULL,
    actor_account_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (principal_kind = 'account'::text) THEN principal_id
    ELSE NULL::uuid
END) STORED,
    CONSTRAINT write_basis_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT write_basis_position_check CHECK (("position" > 0)),
    CONSTRAINT write_basis_principal_check CHECK ((((principal_kind = 'account'::text) AND (principal_id <> '00000000-0000-0000-0000-000000000000'::uuid) AND (client_id IS NOT NULL)) OR ((principal_kind = 'anonymous'::text) AND (principal_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (client_id IS NULL) AND (requested_by IS NULL))))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: agent_identity_history_copy agent_identity_history_copy_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_history_copy
    ADD CONSTRAINT agent_identity_history_copy_pkey PRIMARY KEY (partition_no, source_route, source_account_id, source_direction, source_receipt_id, artifact_type, locator);


--
-- Name: agent_identity_inventory agent_identity_inventory_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_inventory
    ADD CONSTRAINT agent_identity_inventory_pkey PRIMARY KEY (partition_no, source_route, source_account_id, source_direction, source_receipt_id);


--
-- Name: agent_identity_recovery_inventory agent_identity_recovery_inventory_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_recovery_inventory
    ADD CONSTRAINT agent_identity_recovery_inventory_pkey PRIMARY KEY (partition_no, source_route, source_account_id, source_direction, source_receipt_id);


--
-- Name: agent_identity_sdk_obligation agent_identity_sdk_obligation_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_sdk_obligation
    ADD CONSTRAINT agent_identity_sdk_obligation_pkey PRIMARY KEY (partition_no, source_route, source_account_id, source_direction, source_receipt_id);


--
-- Name: agent_identity_work agent_identity_work_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_work
    ADD CONSTRAINT agent_identity_work_pkey PRIMARY KEY (custody_id);


--
-- Name: agent_identity_work_source agent_identity_work_source_custody_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_work_source
    ADD CONSTRAINT agent_identity_work_source_custody_id_key UNIQUE (custody_id);


--
-- Name: agent_identity_work agent_identity_work_source_key_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_work
    ADD CONSTRAINT agent_identity_work_source_key_key UNIQUE (source_key);


--
-- Name: agent_identity_work_source agent_identity_work_source_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_work_source
    ADD CONSTRAINT agent_identity_work_source_pkey PRIMARY KEY (partition_no, source_key);


--
-- Name: agent_identity_work agent_identity_work_workflow_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_work
    ADD CONSTRAINT agent_identity_work_workflow_id_key UNIQUE (workflow_id);


--
-- Name: consumer_checkpoint consumer_checkpoint_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_checkpoint
    ADD CONSTRAINT consumer_checkpoint_pkey PRIMARY KEY (partition_no, consumer);


--
-- Name: consumer_lag consumer_lag_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_lag
    ADD CONSTRAINT consumer_lag_pkey PRIMARY KEY (consumer);


--
-- Name: history_event_consumer history_event_consumer_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_event_consumer
    ADD CONSTRAINT history_event_consumer_pkey PRIMARY KEY (partition_no, "position", event_seq, consumer);


--
-- Name: history_event_consumer history_event_consumer_workflow_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_event_consumer
    ADD CONSTRAINT history_event_consumer_workflow_id_key UNIQUE (workflow_id);


--
-- Name: history_family_coverage history_family_coverage_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_coverage
    ADD CONSTRAINT history_family_coverage_pkey PRIMARY KEY (family, account_route, account_id);


--
-- Name: history_family_definition history_family_definition_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_definition
    ADD CONSTRAINT history_family_definition_pkey PRIMARY KEY (family);


--
-- Name: history_family_domain history_family_domain_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_domain
    ADD CONSTRAINT history_family_domain_pkey PRIMARY KEY (singleton);


--
-- Name: history_family_enrollment history_family_enrollment_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_enrollment
    ADD CONSTRAINT history_family_enrollment_pkey PRIMARY KEY (family, account_route, account_id, partition_no, artifact_type, producer);


--
-- Name: history_family_fence history_family_fence_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_fence
    ADD CONSTRAINT history_family_fence_pkey PRIMARY KEY (account_route, account_id);


--
-- Name: history_family_watch history_family_watch_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_watch
    ADD CONSTRAINT history_family_watch_pkey PRIMARY KEY (partition_no, artifact_type, locator);


--
-- Name: history_locator history_locator_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_locator
    ADD CONSTRAINT history_locator_pkey PRIMARY KEY (partition_no, account_route, account_id, artifact_type, locator);


--
-- Name: history_progress history_progress_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_progress
    ADD CONSTRAINT history_progress_pkey PRIMARY KEY (account_route, account_id, barrier_id, store_kind, partition_no);


--
-- Name: history_receiving_proof history_receiving_proof_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_receiving_proof
    ADD CONSTRAINT history_receiving_proof_pkey PRIMARY KEY (partition_no, account_route, account_id, artifact_type, locator, partition_epoch);


--
-- Name: history_registry history_registry_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_registry
    ADD CONSTRAINT history_registry_pkey PRIMARY KEY (singleton);


--
-- Name: history_seal history_seal_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_seal
    ADD CONSTRAINT history_seal_pkey PRIMARY KEY (partition_no, account_route, account_id);


--
-- Name: history_work history_work_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_work
    ADD CONSTRAINT history_work_pkey PRIMARY KEY (partition_no, work_id);


--
-- Name: identity_fx_original identity_fx_original_partition_no_epoch_position_event_seq__key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_fx_original
    ADD CONSTRAINT identity_fx_original_partition_no_epoch_position_event_seq__key UNIQUE (partition_no, epoch, "position", event_seq, effect);


--
-- Name: identity_fx_original identity_fx_original_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_fx_original
    ADD CONSTRAINT identity_fx_original_pkey PRIMARY KEY (original_id);


--
-- Name: identity_fx_original identity_fx_original_workflow_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_fx_original
    ADD CONSTRAINT identity_fx_original_workflow_id_key UNIQUE (workflow_id);


--
-- Name: identity_fx_receiving identity_fx_receiving_original_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_fx_receiving
    ADD CONSTRAINT identity_fx_receiving_original_id_key UNIQUE (original_id);


--
-- Name: identity_fx_receiving identity_fx_receiving_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_fx_receiving
    ADD CONSTRAINT identity_fx_receiving_pkey PRIMARY KEY (workflow_id);


--
-- Name: identity_history_allocation identity_history_allocation_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_history_allocation
    ADD CONSTRAINT identity_history_allocation_pkey PRIMARY KEY (original_id);


--
-- Name: identity_history_original identity_history_original_ordinal_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_history_original
    ADD CONSTRAINT identity_history_original_ordinal_key UNIQUE (ordinal);


--
-- Name: identity_history_original identity_history_original_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_history_original
    ADD CONSTRAINT identity_history_original_pkey PRIMARY KEY (original_id);


--
-- Name: operational_work_episode operational_work_episode_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_episode
    ADD CONSTRAINT operational_work_episode_pkey PRIMARY KEY (partition_no, route, owner_account_id, collection_id, episode_id);


--
-- Name: operational_work_head operational_work_head_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_head
    ADD CONSTRAINT operational_work_head_pkey PRIMARY KEY (partition_no);


--
-- Name: operational_work_mapping operational_work_mapping_partition_no_workflow_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_mapping
    ADD CONSTRAINT operational_work_mapping_partition_no_workflow_id_key UNIQUE (partition_no, workflow_id);


--
-- Name: operational_work_mapping operational_work_mapping_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_mapping
    ADD CONSTRAINT operational_work_mapping_pkey PRIMARY KEY (partition_no, custody_id);


--
-- Name: operational_work_original operational_work_original_partition_no_source_epoch_source__key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_original
    ADD CONSTRAINT operational_work_original_partition_no_source_epoch_source__key UNIQUE (partition_no, source_epoch, source_position);


--
-- Name: operational_work_original operational_work_original_partition_no_transaction_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_original
    ADD CONSTRAINT operational_work_original_partition_no_transaction_id_key UNIQUE (partition_no, transaction_id);


--
-- Name: operational_work_original operational_work_original_partition_no_workflow_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_original
    ADD CONSTRAINT operational_work_original_partition_no_workflow_id_key UNIQUE (partition_no, workflow_id);


--
-- Name: operational_work_original operational_work_original_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_original
    ADD CONSTRAINT operational_work_original_pkey PRIMARY KEY (partition_no, custody_id);


--
-- Name: operational_work_selected_continuation operational_work_selected_continuation_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_selected_continuation
    ADD CONSTRAINT operational_work_selected_continuation_pkey PRIMARY KEY (partition_no, workflow_id);


--
-- Name: operational_work_selection operational_work_selection_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_selection
    ADD CONSTRAINT operational_work_selection_pkey PRIMARY KEY (partition_no, workflow_id, function_id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (partition_no, "position", event_seq);


--
-- Name: partition partition_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.partition
    ADD CONSTRAINT partition_pkey PRIMARY KEY (partition_no);


--
-- Name: preference_history_job preference_history_job_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.preference_history_job
    ADD CONSTRAINT preference_history_job_pkey PRIMARY KEY (job_id);


--
-- Name: receipt receipt_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.receipt
    ADD CONSTRAINT receipt_pkey PRIMARY KEY (partition_no, principal_kind, principal_id, command_kind, idempotency_key);


--
-- Name: record_history_locator record_history_locator_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_locator
    ADD CONSTRAINT record_history_locator_pkey PRIMARY KEY (source_key, partition_no, artifact_type, locator);


--
-- Name: record_history_purge record_history_purge_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_purge
    ADD CONSTRAINT record_history_purge_pkey PRIMARY KEY (source_key, deletion_generation);


--
-- Name: record_history_purge_set record_history_purge_set_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_purge_set
    ADD CONSTRAINT record_history_purge_set_pkey PRIMARY KEY (source_key, deletion_generation, source_partition, set_locator, set_revision);


--
-- Name: record_history_source_set_copy record_history_source_set_cop_partition_no_artifact_type_lo_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_source_set_copy
    ADD CONSTRAINT record_history_source_set_cop_partition_no_artifact_type_lo_key UNIQUE (partition_no, artifact_type, locator);


--
-- Name: record_history_source_set_copy record_history_source_set_copy_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_source_set_copy
    ADD CONSTRAINT record_history_source_set_copy_pkey PRIMARY KEY (source_partition, set_locator, set_revision, partition_no, artifact_type, locator);


--
-- Name: record_history_source_set record_history_source_set_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_source_set
    ADD CONSTRAINT record_history_source_set_pkey PRIMARY KEY (source_partition, set_locator, set_revision);


--
-- Name: record_history_source_set record_history_source_set_source_partition_original_transac_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_source_set
    ADD CONSTRAINT record_history_source_set_source_partition_original_transac_key UNIQUE (source_partition, original_transaction);


--
-- Name: write_basis write_basis_partition_no_position_key; Type: CONSTRAINT; Schema: editorial; Owner: -
--

ALTER TABLE ONLY editorial.write_basis
    ADD CONSTRAINT write_basis_partition_no_position_key UNIQUE (partition_no, "position");


--
-- Name: write_basis write_basis_pkey; Type: CONSTRAINT; Schema: editorial; Owner: -
--

ALTER TABLE ONLY editorial.write_basis
    ADD CONSTRAINT write_basis_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: agent_identity_approval_original; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX agent_identity_approval_original ON core.receipt USING btree (partition_no, transaction_id) WHERE ((principal_kind = 'account'::text) AND (command_kind = 'access.agent-verification.approve'::text));


--
-- Name: agent_identity_history_copy_receiver; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX agent_identity_history_copy_receiver ON core.agent_identity_history_copy USING btree (partition_no, artifact_type, locator, source_route, source_account_id, source_direction, source_receipt_id);


--
-- Name: agent_identity_reversal_original; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX agent_identity_reversal_original ON core.receipt USING btree (partition_no, transaction_id) WHERE ((principal_kind = 'account'::text) AND (command_kind = ANY (ARRAY['access.agent-verification.released'::text, 'access.agent-verification.revoked'::text, 'access.agent-verification.deleted'::text])));


--
-- Name: agent_identity_reversal_terminal_receipt; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX agent_identity_reversal_terminal_receipt ON core.receipt USING btree (partition_no, transaction_id) WHERE (command_kind = 'access.agent-verification.reversed'::text);


--
-- Name: commerce_live_copy_receipt_position; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX commerce_live_copy_receipt_position ON core.receipt USING btree (partition_no, "position") WHERE ((principal_kind = 'account'::text) AND (command_kind = ANY (ARRAY['commerce.checkout.record'::text, 'commerce.checkout.refresh'::text, 'commerce.checkout.apply'::text])));


--
-- Name: commerce_live_copy_receipt_transaction; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX commerce_live_copy_receipt_transaction ON core.receipt USING btree (partition_no, transaction_id) WHERE ((principal_kind = 'account'::text) AND (command_kind = ANY (ARRAY['commerce.checkout.record'::text, 'commerce.checkout.refresh'::text, 'commerce.checkout.apply'::text])));


--
-- Name: consumer_checkpoint_consumer_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX consumer_checkpoint_consumer_idx ON core.consumer_checkpoint USING btree (consumer, partition_no);


--
-- Name: history_family_runnable; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_family_runnable ON core.history_family_coverage USING btree (next_run, family, account_route, account_id) WHERE (phase = 'scan'::text);


--
-- Name: history_family_stale; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_family_stale ON core.history_family_coverage USING btree (domain_generation, family, account_route, account_id) WHERE (phase <> 'scan'::text);


--
-- Name: history_family_watch_source; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX history_family_watch_source ON core.history_family_watch USING btree (partition_no, artifact_type, source_key);


--
-- Name: history_job_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_job_pending ON core.preference_history_job USING btree (job_id) WHERE (phase = 'pending'::text);


--
-- Name: history_locator_artifact; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_locator_artifact ON core.history_locator USING btree (partition_no, artifact_type, locator, account_route, account_id);


--
-- Name: history_locator_family_page; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_locator_family_page ON core.history_locator USING btree (partition_no, account_route, account_id, artifact_type, locator);


--
-- Name: history_locator_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_locator_pending ON core.history_locator USING btree (partition_no, account_route, account_id, artifact_type, locator) WHERE (state = 'pending'::text);


--
-- Name: history_progress_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_progress_pending ON core.history_progress USING btree (account_route, account_id, barrier_id, store_kind, partition_no) WHERE (state = 'pending'::text);


--
-- Name: history_registry_redrive; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_registry_redrive ON core.preference_history_job USING btree (registry_generation, job_id);


--
-- Name: history_work_source; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_work_source ON core.history_work USING btree (source_partition, work_id);


--
-- Name: identity_history_original_job; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX identity_history_original_job ON core.identity_history_original USING btree (job_id, ordinal DESC);


--
-- Name: operational_work_mapping_position; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX operational_work_mapping_position ON core.operational_work_mapping USING btree (partition_no, source_partition, source_position) WHERE (source_domain = 'operational-work/v1'::text);


--
-- Name: operational_work_original_position; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX operational_work_original_position ON core.operational_work_original USING btree (partition_no, source_position) WHERE (source_domain = 'operational-work/v1'::text);


--
-- Name: preference_history_barrier; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX preference_history_barrier ON core.preference_history_job USING btree (account_route, account_id, barrier_id);


--
-- Name: preference_history_runnable; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX preference_history_runnable ON core.preference_history_job USING btree (next_run, job_id) WHERE (phase = ANY (ARRAY['scan'::text, 'verify'::text]));


--
-- Name: record_history_copy; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_copy ON core.record_history_locator USING btree (partition_no, artifact_type, locator, source_key);


--
-- Name: record_history_original; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_original ON core.record_history_locator USING btree (partition_no, original_transaction) WHERE (original_position IS NULL);


--
-- Name: record_history_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_pending ON core.record_history_locator USING btree (source_key, next_attempt, partition_no, artifact_type, locator) WHERE (state = 'pending'::text);


--
-- Name: record_history_purge_runnable; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_purge_runnable ON core.record_history_purge USING btree (next_run, source_key, deletion_generation);


--
-- Name: record_history_purge_set_runnable; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_purge_set_runnable ON core.record_history_purge_set USING btree (source_key, deletion_generation, next_attempt, source_partition, set_locator, set_revision);


--
-- Name: record_history_receiving_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_receiving_pending ON core.record_history_locator USING btree (source_key, next_attempt, partition_no, artifact_type, locator) WHERE ((state = 'pending'::text) OR (gap = 'record-source-native-release-pending'::text));


--
-- Name: record_history_source_set_copy_original; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_source_set_copy_original ON core.record_history_source_set_copy USING btree (partition_no, original_transaction) WHERE (original_position IS NULL);


--
-- Name: record_history_source_set_copy_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_source_set_copy_pending ON core.record_history_source_set_copy USING btree (source_partition, set_locator, set_revision, next_attempt, partition_no, artifact_type, locator) WHERE ((state = 'pending'::text) OR (gap = 'record-source-native-release-pending'::text));


--
-- Name: record_history_source_set_original; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX record_history_source_set_original ON core.record_history_source_set USING btree (source_partition, original_transaction) WHERE (original_position IS NULL);


--
-- Name: history_event_consumer agent_identity_consumer_enrollment; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_consumer_enrollment BEFORE INSERT OR DELETE OR UPDATE ON core.history_event_consumer FOR EACH ROW EXECUTE FUNCTION core.agent_identity_receiving_enrollment();


--
-- Name: agent_identity_history_copy agent_identity_history_copy_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_history_copy_guard BEFORE INSERT OR DELETE OR UPDATE ON core.agent_identity_history_copy FOR EACH ROW EXECUTE FUNCTION core.agent_identity_history_copy_guard();


--
-- Name: agent_identity_work agent_identity_history_initial; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_history_initial BEFORE INSERT ON core.agent_identity_work FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_work();

ALTER TABLE core.agent_identity_work ENABLE ALWAYS TRIGGER agent_identity_history_initial;


--
-- Name: agent_identity_history_copy agent_identity_inventory_copy_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_inventory_copy_guard BEFORE INSERT ON core.agent_identity_history_copy FOR EACH ROW EXECUTE FUNCTION core.agent_identity_inventory_copy_guard();


--
-- Name: agent_identity_inventory agent_identity_inventory_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_inventory_guard BEFORE INSERT OR DELETE OR UPDATE ON core.agent_identity_inventory FOR EACH ROW EXECUTE FUNCTION core.agent_identity_inventory_guard();


--
-- Name: agent_identity_inventory agent_identity_inventory_native_commit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_identity_inventory_native_commit AFTER INSERT OR UPDATE ON core.agent_identity_inventory DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.validate_agent_identity_inventory();


--
-- Name: agent_identity_history_copy agent_identity_recovery_copy_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_recovery_copy_guard BEFORE INSERT ON core.agent_identity_history_copy FOR EACH ROW EXECUTE FUNCTION core.agent_identity_recovery_copy_guard();

ALTER TABLE core.agent_identity_history_copy ENABLE ALWAYS TRIGGER agent_identity_recovery_copy_guard;


--
-- Name: agent_identity_recovery_inventory agent_identity_recovery_inventory_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_recovery_inventory_guard BEFORE INSERT OR DELETE OR UPDATE ON core.agent_identity_recovery_inventory FOR EACH ROW EXECUTE FUNCTION core.agent_identity_recovery_inventory_guard();

ALTER TABLE core.agent_identity_recovery_inventory ENABLE ALWAYS TRIGGER agent_identity_recovery_inventory_guard;


--
-- Name: agent_identity_recovery_inventory agent_identity_recovery_inventory_native_commit; Type: TRIGGER; Schema: core; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_identity_recovery_inventory_native_commit AFTER INSERT OR UPDATE ON core.agent_identity_recovery_inventory DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.validate_agent_identity_recovery_inventory();


--
-- Name: history_locator agent_identity_role_enrollment; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_role_enrollment BEFORE INSERT OR DELETE OR UPDATE OF partition_no, account_route, account_id, artifact_type, locator, roles, minimizer_version ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.agent_identity_receiving_enrollment();


--
-- Name: agent_identity_sdk_obligation agent_identity_sdk_obligation_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_sdk_obligation_guard BEFORE INSERT OR DELETE OR UPDATE ON core.agent_identity_sdk_obligation FOR EACH ROW EXECUTE FUNCTION core.agent_identity_sdk_obligation_guard();


--
-- Name: agent_identity_work agent_identity_work_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_work_immutable BEFORE DELETE OR UPDATE ON core.agent_identity_work FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_work();

ALTER TABLE core.agent_identity_work ENABLE ALWAYS TRIGGER agent_identity_work_immutable;


--
-- Name: agent_identity_work_source agent_identity_work_source_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER agent_identity_work_source_immutable BEFORE DELETE OR UPDATE ON core.agent_identity_work_source FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_work();

ALTER TABLE core.agent_identity_work_source ENABLE ALWAYS TRIGGER agent_identity_work_source_immutable;


--
-- Name: agent_identity_work_source agent_identity_work_source_native; Type: TRIGGER; Schema: core; Owner: -
--

CREATE CONSTRAINT TRIGGER agent_identity_work_source_native AFTER INSERT ON core.agent_identity_work_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.validate_agent_identity_work_source();


--
-- Name: partition context_directory_home_change; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER context_directory_home_change AFTER UPDATE OF epoch, write_state ON core.partition FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_invalidate_home();


--
-- Name: partition follow_count_source_topology; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER follow_count_source_topology AFTER INSERT ON core.partition FOR EACH ROW EXECUTE FUNCTION library.install_follow_count_partition();


--
-- Name: history_locator history_agent_identity_locator_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_agent_identity_locator_guard BEFORE UPDATE OF state, proof_barrier ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_history_receiving();

ALTER TABLE core.history_locator ENABLE ALWAYS TRIGGER history_agent_identity_locator_guard;


--
-- Name: history_receiving_proof history_agent_identity_receiving_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_agent_identity_receiving_guard BEFORE INSERT ON core.history_receiving_proof FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_history_receiving();

ALTER TABLE core.history_receiving_proof ENABLE ALWAYS TRIGGER history_agent_identity_receiving_guard;


--
-- Name: history_work history_agent_identity_retirement_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_agent_identity_retirement_guard BEFORE INSERT OR DELETE OR UPDATE ON core.history_work FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_sdk_retirement();

ALTER TABLE core.history_work ENABLE ALWAYS TRIGGER history_agent_identity_retirement_guard;


--
-- Name: history_event_consumer history_consumer_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_consumer_changed AFTER UPDATE OF state ON core.history_event_consumer FOR EACH ROW EXECUTE FUNCTION core.history_consumer_changed();


--
-- Name: history_event_consumer history_family_consumer_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_consumer_changed AFTER INSERT OR DELETE OR UPDATE ON core.history_event_consumer FOR EACH ROW EXECUTE FUNCTION core.history_family_consumer_changed();


--
-- Name: history_family_definition history_family_definition_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_definition_changed AFTER INSERT OR DELETE OR UPDATE OF version, digest, sources, registry_digest ON core.history_family_definition FOR EACH ROW EXECUTE FUNCTION core.history_family_domain_changed();


--
-- Name: history_family_enrollment history_family_enrollment_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_enrollment_changed AFTER INSERT OR DELETE OR UPDATE ON core.history_family_enrollment FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();


--
-- Name: preference_history_job history_family_job_admitted; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_job_admitted AFTER INSERT ON core.preference_history_job FOR EACH ROW EXECUTE FUNCTION core.history_family_job_admitted();


--
-- Name: history_locator history_family_locator_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_locator_changed AFTER INSERT OR DELETE OR UPDATE ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();


--
-- Name: outbox history_family_outbox_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_outbox_changed AFTER DELETE OR UPDATE ON core.outbox FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();


--
-- Name: history_locator history_family_preserve_locator; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_preserve_locator BEFORE DELETE OR UPDATE ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.history_family_preserve_locator();


--
-- Name: receipt history_family_receipt_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_receipt_changed AFTER DELETE OR UPDATE ON core.receipt FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();


--
-- Name: history_receiving_proof history_family_receiving_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_receiving_changed AFTER INSERT ON core.history_receiving_proof FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();


--
-- Name: history_registry history_family_registry_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_registry_changed AFTER INSERT OR DELETE OR UPDATE ON core.history_registry FOR EACH ROW EXECUTE FUNCTION core.history_family_domain_changed();


--
-- Name: partition history_family_route_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_route_changed AFTER INSERT OR DELETE OR UPDATE OF node, write_state, moved_to, epoch ON core.partition FOR EACH STATEMENT EXECUTE FUNCTION core.history_family_domain_changed();


--
-- Name: history_seal history_family_seal_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_seal_changed AFTER INSERT OR DELETE OR UPDATE ON core.history_seal FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();


--
-- Name: history_family_enrollment history_family_validate_enrollment; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_validate_enrollment BEFORE INSERT OR UPDATE ON core.history_family_enrollment FOR EACH ROW EXECUTE FUNCTION core.history_family_validate_enrollment();


--
-- Name: history_family_watch history_family_watch_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_watch_immutable BEFORE DELETE OR UPDATE ON core.history_family_watch FOR EACH ROW EXECUTE FUNCTION core.history_receiving_proof_immutable();


--
-- Name: history_work history_family_work_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_family_work_changed AFTER DELETE OR UPDATE ON core.history_work FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();


--
-- Name: history_locator history_locator_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_locator_guard BEFORE INSERT OR UPDATE OF partition_no, account_route, account_id, artifact_type, locator, roles, minimizer_version ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.history_guard_locator();


--
-- Name: outbox history_outbox_irreversible; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_outbox_irreversible BEFORE UPDATE ON core.outbox FOR EACH ROW EXECUTE FUNCTION core.history_payload_irreversible();


--
-- Name: receipt history_receipt_irreversible; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_receipt_irreversible BEFORE UPDATE ON core.receipt FOR EACH ROW EXECUTE FUNCTION core.history_payload_irreversible();


--
-- Name: history_receiving_proof history_receiving_proof_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_receiving_proof_immutable BEFORE DELETE OR UPDATE ON core.history_receiving_proof FOR EACH ROW EXECUTE FUNCTION core.history_receiving_proof_immutable();


--
-- Name: history_work history_retirement_irreversible; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_retirement_irreversible BEFORE UPDATE ON core.history_work FOR EACH ROW EXECUTE FUNCTION core.history_retirement_irreversible();


--
-- Name: history_seal history_seal_preserve; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_seal_preserve BEFORE DELETE OR UPDATE ON core.history_seal FOR EACH ROW EXECUTE FUNCTION core.history_preserve_seal();


--
-- Name: history_work history_work_changed; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_work_changed AFTER UPDATE OF owner_ready, absence_verified ON core.history_work FOR EACH ROW EXECUTE FUNCTION core.history_work_changed();


--
-- Name: partition identity_epoch_prearm_owner_gate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_owner_gate BEFORE DELETE OR UPDATE ON core.partition FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_owner();


--
-- Name: identity_fx_original identity_fx_original_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER identity_fx_original_guard BEFORE DELETE OR UPDATE ON core.identity_fx_original FOR EACH ROW EXECUTE FUNCTION core.guard_identity_original_control();


--
-- Name: identity_fx_receiving identity_fx_receiving_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER identity_fx_receiving_guard BEFORE DELETE OR UPDATE ON core.identity_fx_receiving FOR EACH ROW EXECUTE FUNCTION core.guard_identity_original_control();


--
-- Name: identity_history_allocation identity_history_allocation_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER identity_history_allocation_guard BEFORE INSERT OR DELETE OR UPDATE ON core.identity_history_allocation FOR EACH ROW EXECUTE FUNCTION core.guard_identity_history_allocation();


--
-- Name: identity_history_original identity_history_original_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER identity_history_original_guard BEFORE DELETE OR UPDATE ON core.identity_history_original FOR EACH ROW EXECUTE FUNCTION core.guard_identity_original_control();


--
-- Name: partition live_copy_partition_activation_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER live_copy_partition_activation_guard BEFORE INSERT OR UPDATE ON core.partition FOR EACH ROW EXECUTE FUNCTION access.live_copy_partition_activation_guard();


--
-- Name: history_work operational_work_custody_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_custody_guard BEFORE INSERT OR DELETE OR UPDATE ON core.history_work FOR EACH ROW EXECUTE FUNCTION core.operational_work_custody_guard();

ALTER TABLE core.history_work ENABLE ALWAYS TRIGGER operational_work_custody_guard;


--
-- Name: operational_work_episode operational_work_episode_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_episode_immutable BEFORE DELETE OR UPDATE ON core.operational_work_episode FOR EACH ROW EXECUTE FUNCTION core.operational_work_immutable();

ALTER TABLE core.operational_work_episode ENABLE ALWAYS TRIGGER operational_work_episode_immutable;


--
-- Name: operational_work_episode operational_work_episode_no_truncate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_episode_no_truncate BEFORE TRUNCATE ON core.operational_work_episode FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_immutable();

ALTER TABLE core.operational_work_episode ENABLE ALWAYS TRIGGER operational_work_episode_no_truncate;


--
-- Name: operational_work_head operational_work_head_bound; Type: TRIGGER; Schema: core; Owner: -
--

CREATE CONSTRAINT TRIGGER operational_work_head_bound AFTER INSERT OR UPDATE ON core.operational_work_head DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.operational_work_head_bound();

ALTER TABLE core.operational_work_head ENABLE ALWAYS TRIGGER operational_work_head_bound;


--
-- Name: operational_work_head operational_work_head_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_head_guard BEFORE INSERT OR DELETE OR UPDATE ON core.operational_work_head FOR EACH ROW EXECUTE FUNCTION core.operational_work_head_guard();

ALTER TABLE core.operational_work_head ENABLE ALWAYS TRIGGER operational_work_head_guard;


--
-- Name: operational_work_head operational_work_head_no_truncate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_head_no_truncate BEFORE TRUNCATE ON core.operational_work_head FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_head_guard();

ALTER TABLE core.operational_work_head ENABLE ALWAYS TRIGGER operational_work_head_no_truncate;


--
-- Name: history_locator operational_work_locator_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_locator_guard BEFORE DELETE OR UPDATE ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.operational_work_custody_guard();

ALTER TABLE core.history_locator ENABLE ALWAYS TRIGGER operational_work_locator_guard;


--
-- Name: operational_work_mapping operational_work_mapping_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_mapping_immutable BEFORE DELETE OR UPDATE ON core.operational_work_mapping FOR EACH ROW EXECUTE FUNCTION core.operational_work_immutable();

ALTER TABLE core.operational_work_mapping ENABLE ALWAYS TRIGGER operational_work_mapping_immutable;


--
-- Name: operational_work_mapping operational_work_mapping_no_truncate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_mapping_no_truncate BEFORE TRUNCATE ON core.operational_work_mapping FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_immutable();

ALTER TABLE core.operational_work_mapping ENABLE ALWAYS TRIGGER operational_work_mapping_no_truncate;


--
-- Name: operational_work_mapping operational_work_mapping_stamp; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_mapping_stamp BEFORE INSERT ON core.operational_work_mapping FOR EACH ROW EXECUTE FUNCTION core.operational_work_mapping_stamp();

ALTER TABLE core.operational_work_mapping ENABLE ALWAYS TRIGGER operational_work_mapping_stamp;


--
-- Name: operational_work_original operational_work_original_immutable; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_original_immutable BEFORE DELETE OR UPDATE ON core.operational_work_original FOR EACH ROW EXECUTE FUNCTION core.operational_work_immutable();

ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_original_immutable;


--
-- Name: operational_work_original operational_work_original_no_truncate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_original_no_truncate BEFORE TRUNCATE ON core.operational_work_original FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_immutable();

ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_original_no_truncate;


--
-- Name: operational_work_original operational_work_position_binding; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_position_binding BEFORE INSERT ON core.operational_work_original FOR EACH ROW EXECUTE FUNCTION core.operational_work_position_binding();

ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_position_binding;


--
-- Name: history_receiving_proof operational_work_receiving_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_receiving_guard BEFORE INSERT ON core.history_receiving_proof FOR EACH ROW EXECUTE FUNCTION core.operational_work_custody_guard();

ALTER TABLE core.history_receiving_proof ENABLE ALWAYS TRIGGER operational_work_receiving_guard;


--
-- Name: operational_work_original operational_work_require_native_seal; Type: TRIGGER; Schema: core; Owner: -
--

CREATE CONSTRAINT TRIGGER operational_work_require_native_seal AFTER INSERT ON core.operational_work_original DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.operational_work_require_native_seal();

ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_require_native_seal;


--
-- Name: history_locator operational_work_role_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_role_guard BEFORE INSERT OR UPDATE ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.operational_work_role_guard();

ALTER TABLE core.history_locator ENABLE ALWAYS TRIGGER operational_work_role_guard;


--
-- Name: operational_work_selected_continuation operational_work_selected_continuation_bound; Type: TRIGGER; Schema: core; Owner: -
--

CREATE CONSTRAINT TRIGGER operational_work_selected_continuation_bound AFTER INSERT ON core.operational_work_selected_continuation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.operational_work_selected_continuation_bound();

ALTER TABLE core.operational_work_selected_continuation ENABLE ALWAYS TRIGGER operational_work_selected_continuation_bound;


--
-- Name: operational_work_selected_continuation operational_work_selected_continuation_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_selected_continuation_guard BEFORE DELETE OR UPDATE ON core.operational_work_selected_continuation FOR EACH ROW EXECUTE FUNCTION core.operational_work_selection_guard();

ALTER TABLE core.operational_work_selected_continuation ENABLE ALWAYS TRIGGER operational_work_selected_continuation_guard;


--
-- Name: operational_work_selected_continuation operational_work_selected_continuation_no_truncate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_selected_continuation_no_truncate BEFORE TRUNCATE ON core.operational_work_selected_continuation FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_selection_guard();

ALTER TABLE core.operational_work_selected_continuation ENABLE ALWAYS TRIGGER operational_work_selected_continuation_no_truncate;


--
-- Name: operational_work_selection operational_work_selection_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_selection_guard BEFORE DELETE OR UPDATE ON core.operational_work_selection FOR EACH ROW EXECUTE FUNCTION core.operational_work_selection_guard();

ALTER TABLE core.operational_work_selection ENABLE ALWAYS TRIGGER operational_work_selection_guard;


--
-- Name: operational_work_selection operational_work_selection_no_truncate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER operational_work_selection_no_truncate BEFORE TRUNCATE ON core.operational_work_selection FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_selection_guard();

ALTER TABLE core.operational_work_selection ENABLE ALWAYS TRIGGER operational_work_selection_no_truncate;


--
-- Name: consumer_checkpoint public_filter_creation_checkpoint_retained; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER public_filter_creation_checkpoint_retained BEFORE DELETE OR UPDATE ON core.consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_creation_checkpoint();


--
-- Name: record_history_locator record_history_preserve_copy; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER record_history_preserve_copy BEFORE DELETE OR UPDATE ON core.record_history_locator FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_copy();


--
-- Name: record_history_purge_set record_history_preserve_purge_set; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER record_history_preserve_purge_set BEFORE DELETE OR UPDATE ON core.record_history_purge_set FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_purge_set();


--
-- Name: record_history_source_set record_history_preserve_source_set; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER record_history_preserve_source_set BEFORE DELETE OR UPDATE ON core.record_history_source_set FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_source_set();


--
-- Name: record_history_source_set_copy record_history_preserve_source_set_copy; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER record_history_preserve_source_set_copy BEFORE DELETE OR UPDATE ON core.record_history_source_set_copy FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_source_set();


--
-- Name: partition record_purge_source_home_gate; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER record_purge_source_home_gate BEFORE UPDATE OF epoch, write_state, moved_to ON core.partition FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_home_gate();


--
-- Name: agent_identity_history_copy agent_identity_history_copy_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_history_copy
    ADD CONSTRAINT agent_identity_history_copy_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: agent_identity_history_copy agent_identity_history_copy_partition_no_source_route_sour_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_history_copy
    ADD CONSTRAINT agent_identity_history_copy_partition_no_source_route_sour_fkey FOREIGN KEY (partition_no, source_route, source_account_id, artifact_type, locator) REFERENCES core.history_locator(partition_no, account_route, account_id, artifact_type, locator);


--
-- Name: agent_identity_inventory agent_identity_inventory_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_inventory
    ADD CONSTRAINT agent_identity_inventory_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: agent_identity_inventory agent_identity_inventory_source_route_source_account_id_so_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_inventory
    ADD CONSTRAINT agent_identity_inventory_source_route_source_account_id_so_fkey FOREIGN KEY (source_route, source_account_id, source_direction, source_receipt_id) REFERENCES access.agent_identity_intent(route, account_id, direction, receipt_id);


--
-- Name: agent_identity_recovery_inventory agent_identity_recovery_inventory_source_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_recovery_inventory
    ADD CONSTRAINT agent_identity_recovery_inventory_source_fkey FOREIGN KEY (source_route, source_account_id, source_direction, source_receipt_id) REFERENCES access.agent_identity_recovery(route, account_id, direction, receipt_id);


--
-- Name: agent_identity_sdk_obligation agent_identity_sdk_obligation_partition_no_source_route_so_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_sdk_obligation
    ADD CONSTRAINT agent_identity_sdk_obligation_partition_no_source_route_so_fkey FOREIGN KEY (partition_no, source_route, source_account_id, source_direction, source_receipt_id) REFERENCES core.agent_identity_inventory(partition_no, source_route, source_account_id, source_direction, source_receipt_id);


--
-- Name: agent_identity_work_source agent_identity_work_source_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.agent_identity_work_source
    ADD CONSTRAINT agent_identity_work_source_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: consumer_checkpoint consumer_checkpoint_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_checkpoint
    ADD CONSTRAINT consumer_checkpoint_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_event_consumer history_event_consumer_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_event_consumer
    ADD CONSTRAINT history_event_consumer_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_family_coverage history_family_coverage_account_route_account_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_coverage
    ADD CONSTRAINT history_family_coverage_account_route_account_id_fkey FOREIGN KEY (account_route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_family_coverage history_family_coverage_family_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_coverage
    ADD CONSTRAINT history_family_coverage_family_fkey FOREIGN KEY (family) REFERENCES core.history_family_definition(family);


--
-- Name: history_family_enrollment history_family_enrollment_account_route_account_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_enrollment
    ADD CONSTRAINT history_family_enrollment_account_route_account_id_fkey FOREIGN KEY (account_route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_family_enrollment history_family_enrollment_family_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_enrollment
    ADD CONSTRAINT history_family_enrollment_family_fkey FOREIGN KEY (family) REFERENCES core.history_family_definition(family);


--
-- Name: history_family_enrollment history_family_enrollment_partition_no_account_route_accou_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_enrollment
    ADD CONSTRAINT history_family_enrollment_partition_no_account_route_accou_fkey FOREIGN KEY (partition_no, account_route, account_id) REFERENCES core.history_seal(partition_no, account_route, account_id);


--
-- Name: history_family_enrollment history_family_enrollment_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_enrollment
    ADD CONSTRAINT history_family_enrollment_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_family_fence history_family_fence_account_route_account_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_family_fence
    ADD CONSTRAINT history_family_fence_account_route_account_id_fkey FOREIGN KEY (account_route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_locator history_locator_account_route_proof_barrier_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_locator
    ADD CONSTRAINT history_locator_account_route_proof_barrier_fkey FOREIGN KEY (account_route, proof_barrier) REFERENCES access.erasure(route, account_id);


--
-- Name: history_locator history_locator_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_locator
    ADD CONSTRAINT history_locator_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_progress history_progress_account_route_barrier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_progress
    ADD CONSTRAINT history_progress_account_route_barrier_id_fkey FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_progress history_progress_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_progress
    ADD CONSTRAINT history_progress_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_receiving_proof history_receiving_proof_partition_no_account_route_account_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_receiving_proof
    ADD CONSTRAINT history_receiving_proof_partition_no_account_route_account_fkey FOREIGN KEY (partition_no, account_route, account_id, artifact_type, locator) REFERENCES core.history_locator(partition_no, account_route, account_id, artifact_type, locator);


--
-- Name: history_receiving_proof history_receiving_proof_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_receiving_proof
    ADD CONSTRAINT history_receiving_proof_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_seal history_seal_account_route_barrier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_seal
    ADD CONSTRAINT history_seal_account_route_barrier_id_fkey FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_seal history_seal_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_seal
    ADD CONSTRAINT history_seal_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_work history_work_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_work
    ADD CONSTRAINT history_work_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: identity_history_allocation identity_history_allocation_original_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_history_allocation
    ADD CONSTRAINT identity_history_allocation_original_id_fkey FOREIGN KEY (original_id) REFERENCES core.identity_history_original(original_id);


--
-- Name: operational_work_episode operational_work_episode_partition_no_custody_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_episode
    ADD CONSTRAINT operational_work_episode_partition_no_custody_id_fkey FOREIGN KEY (partition_no, custody_id) REFERENCES core.operational_work_original(partition_no, custody_id);


--
-- Name: operational_work_head operational_work_head_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_head
    ADD CONSTRAINT operational_work_head_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: operational_work_mapping operational_work_mapping_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_mapping
    ADD CONSTRAINT operational_work_mapping_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: operational_work_original operational_work_original_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_original
    ADD CONSTRAINT operational_work_original_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: operational_work_selected_continuation operational_work_selected_con_partition_no_parent_workflow_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_selected_continuation
    ADD CONSTRAINT operational_work_selected_con_partition_no_parent_workflow_fkey FOREIGN KEY (partition_no, parent_workflow_id, parent_function_id) REFERENCES core.operational_work_selection(partition_no, workflow_id, function_id);


--
-- Name: operational_work_selected_continuation operational_work_selected_continua_partition_no_custody_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_selected_continuation
    ADD CONSTRAINT operational_work_selected_continua_partition_no_custody_id_fkey FOREIGN KEY (partition_no, custody_id) REFERENCES core.operational_work_original(partition_no, custody_id);


--
-- Name: operational_work_selection operational_work_selection_partition_no_custody_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_selection
    ADD CONSTRAINT operational_work_selection_partition_no_custody_id_fkey FOREIGN KEY (partition_no, custody_id) REFERENCES core.operational_work_original(partition_no, custody_id);


--
-- Name: operational_work_selection operational_work_selection_partition_no_route_owner_accoun_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.operational_work_selection
    ADD CONSTRAINT operational_work_selection_partition_no_route_owner_accoun_fkey FOREIGN KEY (partition_no, route, owner_account_id, collection_id, episode_id) REFERENCES core.operational_work_episode(partition_no, route, owner_account_id, collection_id, episode_id);


--
-- Name: outbox outbox_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.outbox
    ADD CONSTRAINT outbox_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: preference_history_job preference_history_job_account_route_barrier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.preference_history_job
    ADD CONSTRAINT preference_history_job_account_route_barrier_id_fkey FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure(route, account_id);


--
-- Name: preference_history_job preference_history_job_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.preference_history_job
    ADD CONSTRAINT preference_history_job_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: receipt receipt_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.receipt
    ADD CONSTRAINT receipt_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: record_history_locator record_history_locator_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_locator
    ADD CONSTRAINT record_history_locator_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: record_history_purge record_history_purge_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_purge
    ADD CONSTRAINT record_history_purge_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: record_history_purge_set record_history_purge_set_source_key_deletion_generation_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_purge_set
    ADD CONSTRAINT record_history_purge_set_source_key_deletion_generation_fkey FOREIGN KEY (source_key, deletion_generation) REFERENCES core.record_history_purge(source_key, deletion_generation);


--
-- Name: record_history_source_set_copy record_history_source_set_copy_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_source_set_copy
    ADD CONSTRAINT record_history_source_set_copy_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: record_history_source_set record_history_source_set_source_partition_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.record_history_source_set
    ADD CONSTRAINT record_history_source_set_source_partition_fkey FOREIGN KEY (source_partition) REFERENCES core.partition(partition_no);


--
-- Name: write_basis write_basis_partition_no_fkey; Type: FK CONSTRAINT; Schema: editorial; Owner: -
--

ALTER TABLE ONLY editorial.write_basis
    ADD CONSTRAINT write_basis_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- PostgreSQL database dump complete
--


