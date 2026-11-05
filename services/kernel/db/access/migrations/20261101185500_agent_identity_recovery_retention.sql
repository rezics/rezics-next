-- migrate:up
-- The later recovery writer owns a separate, exact two-slot serializer cut. This does not
-- certify or mutate the original command cut or its independent SDK obligation.
ALTER TABLE access.agent_identity_recovery
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD COLUMN original_source_minimized boolean NOT NULL DEFAULT false;

CREATE TABLE core.agent_identity_recovery_inventory (
  partition_no integer NOT NULL,
  source_route integer NOT NULL,
  source_account_id uuid NOT NULL,
  source_direction text NOT NULL,
  source_receipt_id uuid NOT NULL,
  source_digest text NOT NULL,
  recovery_epoch integer NOT NULL,
  recovery_position bigint NOT NULL,
  recovery_transaction_id uuid NOT NULL,
  receiver_epoch integer NOT NULL,
  domain_generation bigint NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  producer_version integer NOT NULL DEFAULT 1,
  conversion_coverage text NOT NULL DEFAULT 'native-receipt-outbox/v1',
  native_writer_state text NOT NULL DEFAULT 'open',
  native_command_kind text NOT NULL,
  native_principal_kind text NOT NULL,
  native_principal_id uuid NOT NULL,
  native_receipt_key text NOT NULL,
  native_request_digest bytea NOT NULL,
  expected_accounts jsonb NOT NULL,
  expected_locators bytea[],
  expected_event_types text[],
  state text NOT NULL DEFAULT 'declared',
  CONSTRAINT agent_identity_recovery_inventory_pkey PRIMARY KEY
    (partition_no,source_route,source_account_id,source_direction,source_receipt_id),
  CONSTRAINT agent_identity_recovery_inventory_source_fkey FOREIGN KEY
    (source_route,source_account_id,source_direction,source_receipt_id)
    REFERENCES access.agent_identity_recovery(route,account_id,direction,receipt_id),
  CONSTRAINT agent_identity_recovery_inventory_route_check CHECK
    (source_route=get_byte(uuid_send(source_account_id),10)*256+get_byte(uuid_send(source_account_id),11)),
  CONSTRAINT agent_identity_recovery_inventory_partition_check CHECK (partition_no=source_route/16),
  CONSTRAINT agent_identity_recovery_inventory_key_check CHECK
    (source_direction IN ('account-agent.verify','account-agent.unverify')),
  CONSTRAINT agent_identity_recovery_inventory_digest_check CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_identity_recovery_inventory_position_check CHECK (recovery_position>0),
  CONSTRAINT agent_identity_recovery_inventory_epoch_check CHECK
    (recovery_epoch>0 AND receiver_epoch>0 AND recovery_epoch=receiver_epoch),
  CONSTRAINT agent_identity_recovery_inventory_domain_check CHECK (domain_generation>0 AND generation=1),
  CONSTRAINT agent_identity_recovery_inventory_producer_check CHECK
    (producer_version=1 AND conversion_coverage='native-receipt-outbox/v1'),
  CONSTRAINT agent_identity_recovery_inventory_writer_check CHECK (native_writer_state IN ('open','closed')),
  CONSTRAINT agent_identity_recovery_inventory_command_check CHECK
    (native_command_kind='access.agent-identity.recover' AND native_principal_kind='account'),
  CONSTRAINT agent_identity_recovery_inventory_request_check CHECK (octet_length(native_request_digest)=32),
  CONSTRAINT agent_identity_recovery_inventory_accounts_check CHECK
    (jsonb_typeof(expected_accounts)='array' AND jsonb_array_length(expected_accounts) BETWEEN 1 AND 64),
  CONSTRAINT agent_identity_recovery_inventory_cut_check CHECK
    ((state='declared' AND expected_locators IS NULL AND expected_event_types IS NULL AND native_writer_state='open') OR
     (state='sealed' AND expected_locators IS NOT NULL AND cardinality(expected_locators)=2
       AND expected_event_types IS NOT NULL AND expected_event_types=ARRAY['com.rezics.access.account-updated.v1']
       AND native_writer_state='closed')),
  CONSTRAINT agent_identity_recovery_inventory_state_check CHECK (state IN ('declared','sealed'))
);

CREATE FUNCTION access.agent_identity_recovery_skeleton(s jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object(
   'digest',s->'digest',
   'native',jsonb_build_object('partition',s->'native'->'partition','epoch',s->'native'->'epoch',
     'position',s->'native'->'position','transactionId',s->'native'->'transactionId'),
   'job',jsonb_build_object('jobId',s->'job'->'jobId','epoch',s->'job'->'epoch'),
   'claim',jsonb_build_object('partition',s->'claim'->'partition','generation',s->'claim'->'generation',
     'transactionId',s->'claim'->'transactionId','home',s->'claim'->'home','scope',s->'claim'->'scope'));
$$;

CREATE FUNCTION access.guard_agent_identity_recovery_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.original_source_minimized THEN
   RAISE EXCEPTION 'New recovery source cannot claim prior minimization' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_identity_recovery_insert_guard BEFORE INSERT ON access.agent_identity_recovery
  FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_recovery_insert();
ALTER TABLE access.agent_identity_recovery ENABLE ALWAYS TRIGGER agent_identity_recovery_insert_guard;

CREATE FUNCTION core.agent_identity_recovery_inventory_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE FUNCTION core.agent_identity_recovery_copy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE FUNCTION core.validate_agent_identity_recovery_inventory() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER agent_identity_recovery_inventory_guard BEFORE INSERT OR UPDATE OR DELETE
  ON core.agent_identity_recovery_inventory FOR EACH ROW EXECUTE FUNCTION core.agent_identity_recovery_inventory_guard();
ALTER TABLE core.agent_identity_recovery_inventory ENABLE ALWAYS TRIGGER agent_identity_recovery_inventory_guard;
CREATE CONSTRAINT TRIGGER agent_identity_recovery_inventory_native_commit AFTER INSERT OR UPDATE
  ON core.agent_identity_recovery_inventory DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.validate_agent_identity_recovery_inventory();
CREATE TRIGGER agent_identity_recovery_copy_guard BEFORE INSERT ON core.agent_identity_history_copy
  FOR EACH ROW EXECUTE FUNCTION core.agent_identity_recovery_copy_guard();
ALTER TABLE core.agent_identity_history_copy ENABLE ALWAYS TRIGGER agent_identity_recovery_copy_guard;

-- Recovery associations are not the original SDK enqueue seam. Only an artifact whose
-- association is bound to the exact original sealed cut advances that independent obligation.
CREATE OR REPLACE FUNCTION core.agent_identity_touch_receiving(
  p_partition integer,p_type text,p_locator bytea
) RETURNS void LANGUAGE plpgsql AS $$
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

-- The existing Access Source closure still proves original Source discharge/transfer, original copies,
-- its own durable obligation, the erasure root, and the original SDK fence. Recovery is an additional
-- independent exact cut that can close only its actual receipt/event receiving copies.
CREATE FUNCTION access.check_agent_identity_recovery_retention(
  i access.agent_identity_intent,p_role text,b jsonb,erased uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; c core.agent_identity_recovery_inventory;
 h core.agent_identity_history_copy; role_hash bytea; actual_accounts jsonb; role_count integer;
 supported_roles boolean; n integer:=0; receiver record; receiver_count integer:=0;
 effects_position bigint; expected_workflow text;
BEGIN
 SELECT recovery_epoch,recovery_position,recovery_transaction_id,recovery_receipt_key,intent_digest,
   source_partition,source_epoch,source_position,source_transaction_id,requested_by,decided_by,
   original_source_minimized,
   CASE WHEN original_source_minimized THEN original_source ELSE NULL END AS original_source
   INTO a FROM access.agent_identity_recovery WHERE route=i.route AND account_id=i.account_id
     AND direction=i.direction AND receipt_id=i.receipt_id FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO c FROM core.agent_identity_recovery_inventory WHERE partition_no=i.source_partition
   AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
   AND source_receipt_id=i.receipt_id FOR SHARE;
 IF NOT FOUND OR c.state<>'sealed' OR c.native_writer_state<>'closed' OR
    c.producer_version<>1 OR c.conversion_coverage<>'native-receipt-outbox/v1' OR
    cardinality(c.expected_locators)<>2 OR
    c.expected_event_types IS DISTINCT FROM ARRAY['com.rezics.access.account-updated.v1'] OR
    c.native_command_kind<>'access.agent-identity.recover' OR c.native_principal_kind<>'account' OR
    c.native_receipt_key IS DISTINCT FROM a.recovery_receipt_key OR
    c.source_digest IS DISTINCT FROM a.intent_digest OR
    (c.recovery_epoch,c.recovery_position,c.recovery_transaction_id)
      IS DISTINCT FROM (a.recovery_epoch,a.recovery_position,a.recovery_transaction_id) OR
    (a.source_partition,a.source_epoch,a.source_position,a.source_transaction_id,a.intent_digest)
      IS DISTINCT FROM (i.source_partition,i.source_epoch,i.source_position,i.source_transaction_id,i.intent_digest) OR
    c.receiver_epoch<>c.recovery_epoch OR
    NOT (a.requested_by IS NOT DISTINCT FROM i.requested_by OR
      (p_role='requester' AND a.requested_by IS NULL AND i.requested_by IS NOT NULL)) OR
    NOT (a.decided_by IS NOT DISTINCT FROM i.decided_by OR
      (p_role='decider' AND a.decided_by IS NULL AND i.decided_by IS NOT NULL)) OR
    (a.original_source_minimized AND
      (a.original_source IS NULL OR a.original_source IS DISTINCT FROM access.agent_identity_recovery_skeleton(a.original_source))) THEN
   RAISE EXCEPTION 'identity retention recovery cut changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.partition p JOIN core.history_family_domain d ON d.singleton
   WHERE p.partition_no=c.partition_no AND p.write_state='active' AND p.epoch=c.receiver_epoch
     AND d.generation=c.domain_generation AND p.position>=c.recovery_position FOR SHARE OF p,d;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery restore changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.receipt r WHERE r.partition_no=c.partition_no AND r.principal_kind=c.native_principal_kind
   AND r.principal_id=c.native_principal_id AND r.command_kind=c.native_command_kind
   AND r.idempotency_key=c.native_receipt_key AND r.transaction_id=c.recovery_transaction_id
   AND r.epoch=c.recovery_epoch AND r.position=c.recovery_position AND r.request_digest=c.native_request_digest
   AND r.payload_state='minimized' AND r.response='null'::jsonb FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery receipt remains' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.outbox o WHERE o.partition_no=c.partition_no AND o.epoch=c.recovery_epoch
   AND o.position=c.recovery_position AND o.event_seq=0 AND o.event_count=1
   AND o.type=c.expected_event_types[1] AND o.payload_state='minimized' AND o.data='{}'::jsonb AND o.subject IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery event remains' USING ERRCODE='23514'; END IF;
 SELECT position INTO effects_position FROM core.consumer_checkpoint WHERE partition_no=c.partition_no
   AND consumer='effects' AND position>=c.recovery_position FOR SHARE;
 IF effects_position IS NULL THEN RAISE EXCEPTION 'identity retention recovery effects pending' USING ERRCODE='23514'; END IF;
 expected_workflow:='fx:'||c.recovery_epoch||':'||c.partition_no||':'||c.recovery_position||':0:account_discovery_redrive';
 FOR receiver IN SELECT consumer,workflow_id,state FROM core.history_event_consumer
   WHERE partition_no=c.partition_no AND position=c.recovery_position AND event_seq=0
   ORDER BY consumer LIMIT 33 FOR SHARE
 LOOP
   receiver_count:=receiver_count+1;
   IF receiver_count>32 OR receiver.consumer<>'account_discovery_redrive' OR
      receiver.workflow_id<>expected_workflow OR receiver.state<>'completed' THEN
     RAISE EXCEPTION 'identity retention recovery effect consumer unknown' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF receiver_count<>1 THEN RAISE EXCEPTION 'identity retention recovery effect consumer unavailable' USING ERRCODE='23514'; END IF;
 FOR h IN SELECT * FROM core.agent_identity_history_copy WHERE partition_no=c.partition_no
   AND source_route=c.source_route AND source_account_id=c.source_account_id AND source_direction=c.source_direction
   AND source_receipt_id=c.source_receipt_id AND source_digest=c.source_digest
   AND source_epoch=c.recovery_epoch AND source_position=c.recovery_position
   AND source_transaction_id=c.recovery_transaction_id ORDER BY artifact_type,locator LIMIT 3 FOR SHARE
 LOOP
   n:=n+1;
   IF n>2 OR h.receiver_epoch<>c.receiver_epoch OR h.domain_generation<>c.domain_generation OR
      NOT h.locator=ANY(c.expected_locators) THEN
     RAISE EXCEPTION 'identity retention recovery serializer cut changed' USING ERRCODE='23514'; END IF;
   SELECT jsonb_agg(jsonb_build_array(account_route,account_id::text,roles) ORDER BY account_route,account_id),
     count(*),bool_and(minimizer_version=1),
     sha256(convert_to(replace(json_agg(json_build_array(account_route,account_id,roles)
       ORDER BY account_route,account_id)::text,' ',''),'UTF8'))
     INTO actual_accounts,role_count,supported_roles,role_hash FROM (
       SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
       WHERE partition_no=c.partition_no AND artifact_type=h.artifact_type AND locator=h.locator
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE
     ) scope;
   IF role_count NOT BETWEEN 1 AND 64 OR supported_roles IS DISTINCT FROM true OR
      actual_accounts IS DISTINCT FROM c.expected_accounts THEN
     RAISE EXCEPTION 'identity retention recovery roles changed' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM core.history_receiving_proof p JOIN core.history_locator l
     ON l.partition_no=p.partition_no AND l.account_route=p.account_route AND l.account_id=p.account_id
       AND l.artifact_type=p.artifact_type AND l.locator=p.locator
     JOIN core.history_seal s ON s.partition_no=l.partition_no AND s.account_route=l.account_route AND s.account_id=l.account_id
     WHERE p.partition_no=c.partition_no AND p.account_route=(b->>'accountRoute')::integer
       AND p.account_id=erased AND p.artifact_type=h.artifact_type AND p.locator=h.locator
       AND p.role_digest=role_hash AND p.barrier_version=(b->>'version')::integer AND p.barrier_at=b->>'at'
       AND p.partition_epoch=c.receiver_epoch AND l.state='minimized' AND l.proof_barrier=erased
       AND l.minimizer_version=1 AND s.phase<>'open' AND s.barrier_id=erased FOR SHARE OF p,l,s;
   IF NOT FOUND THEN RAISE EXCEPTION 'identity retention recovery receiving copy pending' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'identity retention recovery cut incomplete' USING ERRCODE='23514'; END IF;
 -- Search owns current discovery enrollment. A checkpoint or a population scan does
 -- not prove its current generation set or same-home closure; keep this transition pending
 -- until History/Work supplies that released-owner observation and final verification.
 RAISE EXCEPTION 'identity retention recovery discovery owner unavailable' USING ERRCODE='23514';
END $$;

CREATE OR REPLACE FUNCTION access.check_agent_identity_retention(i access.agent_identity_intent,p_role text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE m core.agent_identity_work; inv core.agent_identity_inventory;
 o core.agent_identity_sdk_obligation; b jsonb; ref jsonb; erased uuid; c record;
 l record; role_hash bytea; supported_roles boolean; n integer:=0; k integer; r record;
BEGIN
 IF i.source_partition<>0 OR p_role IS NULL OR p_role NOT IN ('subject','requester','decider') THEN
   RAISE EXCEPTION 'identity retention source home unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT m FROM core.agent_identity_work WHERE source_key=i.delivery_key FOR SHARE;
 ref:=m.history_authority->'reference'; b:=ref->'barrier';
 erased:=CASE p_role WHEN 'subject' THEN i.account_id WHEN 'requester' THEN i.requested_by ELSE i.decided_by END;
 IF erased IS NULL OR ref->>'erasedRole' IS DISTINCT FROM p_role OR
    b->>'accountId' IS DISTINCT FROM erased::text OR (b->>'accountRoute')::integer/16<>0 OR
    ref->'receipt' IS DISTINCT FROM jsonb_build_object('kind',i.direction,'account',i.account_id,'receipt',i.receipt_id) OR
    ref->>'sourceDigest' IS DISTINCT FROM i.intent_digest OR
    ref->'source' IS DISTINCT FROM jsonb_build_object('partition',i.source_partition,'epoch',i.source_epoch,
      'position',i.source_position::text,'transactionId',i.source_transaction_id) OR
    m.workflow_id IS DISTINCT FROM i.workflow_id OR m.source->>'digest' IS DISTINCT FROM i.intent_digest OR
    m.sdk_readiness IS NULL OR m.sdk_closure IS NULL OR m.sdk_retirement_receipt IS NULL OR
    (p_role='subject' AND m.history_authority->>'disposition' IS DISTINCT FROM 'discharged') OR
    (p_role<>'subject' AND m.history_authority->>'disposition' IS DISTINCT FROM 'transferred') THEN
   RAISE EXCEPTION 'identity retention original custody changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM access.erasure e JOIN access.account a ON a.route=e.route AND a.account_id=e.account_id
   WHERE e.route=(b->>'accountRoute')::integer AND e.account_id=erased
     AND e.version=(b->>'version')::integer AND e.at=(b->>'at')::timestamptz
     AND a.state='deleted' AND a.authn_fenced FOR SHARE OF e,a;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention root changed' USING ERRCODE='23514'; END IF;
 PERFORM core.check_agent_identity_history(m.custody_id,m.sdk_readiness->'binding',m.history_authority,m.sdk_closure,'closure');
 PERFORM core.check_agent_identity_history_absence(m.custody_id);
 SELECT * INTO STRICT inv FROM core.agent_identity_inventory WHERE partition_no=i.source_partition
   AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
   AND source_receipt_id=i.receipt_id FOR SHARE;
 SELECT * INTO STRICT o FROM core.agent_identity_sdk_obligation WHERE partition_no=i.source_partition
   AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
   AND source_receipt_id=i.receipt_id FOR SHARE;
 IF inv.state<>'sealed' OR inv.native_writer_state<>'closed' OR inv.producer_version<>1 OR
    inv.conversion_coverage<>'native-receipt-outbox/v1' OR cardinality(inv.expected_locators) NOT BETWEEN 2 AND 3 OR
    inv.generation<>o.generation OR inv.receiver_epoch<>i.source_epoch OR
    (inv.source_digest,inv.source_epoch,inv.source_position,inv.source_transaction_id) IS DISTINCT FROM
    (i.intent_digest,i.source_epoch,i.source_position,i.source_transaction_id) THEN
   RAISE EXCEPTION 'identity retention native cut changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.history_family_domain WHERE singleton AND generation=inv.domain_generation FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention restore changed' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT 'durable-work/v1'::text AS artifact_type,
     decode('0103','hex')||convert_to(m.custody_id::text,'UTF8') AS locator,
     m.receiver_epoch AS receiver_epoch
   UNION ALL SELECT h.artifact_type,h.locator,h.receiver_epoch FROM (
     SELECT * FROM core.agent_identity_history_copy WHERE partition_no=i.source_partition
       AND source_route=i.route AND source_account_id=i.account_id AND source_direction=i.direction
       AND source_receipt_id=i.receipt_id ORDER BY artifact_type,locator LIMIT 4 FOR SHARE
   ) h WHERE h.source_digest=i.intent_digest AND h.source_epoch=i.source_epoch
     AND h.source_position=i.source_position AND h.source_transaction_id=i.source_transaction_id
     AND h.domain_generation=inv.domain_generation AND h.receiver_epoch=inv.receiver_epoch
 LOOP
   n:=n+1;
   IF n>4 OR (c.artifact_type<>'durable-work/v1' AND NOT c.locator=ANY(inv.expected_locators)) THEN
     RAISE EXCEPTION 'identity retention copy cut changed' USING ERRCODE='23514'; END IF;
   SELECT sha256(convert_to(replace(json_agg(json_build_array(account_route,account_id,roles)
       ORDER BY account_route,account_id)::text,' ',''),'UTF8')),count(*),bool_and(minimizer_version=1)
       INTO role_hash,k,supported_roles FROM (
     SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator WHERE partition_no=0
       AND artifact_type=c.artifact_type AND locator=c.locator ORDER BY account_route,account_id LIMIT 65 FOR SHARE
   ) scope;
   IF k NOT BETWEEN 1 AND 64 OR supported_roles IS DISTINCT FROM true THEN RAISE EXCEPTION 'identity retention role union changed' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM core.history_receiving_proof p JOIN core.history_locator l
     ON l.partition_no=p.partition_no AND l.account_route=p.account_route AND l.account_id=p.account_id
       AND l.artifact_type=p.artifact_type AND l.locator=p.locator
     JOIN core.history_seal s ON s.partition_no=l.partition_no AND s.account_route=l.account_route AND s.account_id=l.account_id
     WHERE p.partition_no=0 AND p.account_route=(b->>'accountRoute')::integer AND p.account_id=erased
       AND p.artifact_type=c.artifact_type AND p.locator=c.locator AND p.role_digest=role_hash
       AND p.barrier_version=(b->>'version')::integer AND p.barrier_at=b->>'at' AND p.partition_epoch=c.receiver_epoch
       AND l.state='minimized' AND l.proof_barrier=erased AND l.minimizer_version=1
       AND s.phase<>'open' AND s.barrier_id=erased FOR SHARE OF p,l,s;
   IF NOT FOUND THEN RAISE EXCEPTION 'identity retention receiving copy pending' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n<>cardinality(inv.expected_locators)+1 THEN
   RAISE EXCEPTION 'identity retention copy cut incomplete' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.history_work WHERE partition_no=0 AND work_id=m.custody_id
   AND owner='access.agent-identity' AND request_digest=m.request_digest AND state='retired'
   AND owner_ready AND absence_verified AND request IS NULL AND scope IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention durable physical copy remains' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.receipt WHERE partition_no=0 AND principal_kind=inv.native_principal_kind
   AND principal_id=inv.native_principal_id AND command_kind=inv.native_command_kind AND idempotency_key=inv.native_receipt_key
   AND transaction_id=i.source_transaction_id AND epoch=i.source_epoch AND position=i.source_position
   AND payload_state='minimized' AND response='null'::jsonb FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity retention receipt physical copy remains' USING ERRCODE='23514'; END IF;
 k:=0;
 FOR r IN SELECT * FROM core.outbox WHERE partition_no=0 AND position=i.source_position
   ORDER BY event_seq LIMIT 3 FOR SHARE
 LOOP
   k:=k+1;
   IF k>2 OR r.epoch<>i.source_epoch OR r.payload_state<>'minimized' OR r.data<>'{}'::jsonb OR r.subject IS NOT NULL
     OR r.type IS DISTINCT FROM inv.expected_event_types[k] THEN
     RAISE EXCEPTION 'identity retention outbox physical copy remains' USING ERRCODE='23514'; END IF;
   n:=0;
   FOR l IN SELECT * FROM core.history_event_consumer WHERE partition_no=0 AND position=r.position
     AND event_seq=r.event_seq ORDER BY consumer LIMIT 33 FOR SHARE
   LOOP
     n:=n+1;
     IF n>32 OR l.workflow_id<>m.workflow_id OR l.state NOT IN ('completed','transferred') OR
        o.handoff_partition<>0 OR o.handoff_epoch<>r.epoch OR o.handoff_position<>r.position OR
        o.handoff_event_type<>r.type OR o.handoff_transaction_id<>i.source_transaction_id OR
        l.consumer<>'agent_verification_reversal' OR i.direction<>'account-agent.unverify' THEN
       RAISE EXCEPTION 'outbox-receiving-custody-unavailable' USING ERRCODE='23514'; END IF;
   END LOOP;
 END LOOP;
 IF k<>cardinality(inv.expected_event_types) THEN
   RAISE EXCEPTION 'identity retention original outbox incomplete' USING ERRCODE='23514'; END IF;
 PERFORM access.check_agent_identity_recovery_retention(i,p_role,b,erased);
END $$;

CREATE OR REPLACE FUNCTION access.guard_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role text; erased uuid; i access.agent_identity_intent; a access.agent_identity_recovery;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Account identity source requires receiving erasure custody' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='agent_identity_recovery' THEN
   SELECT * INTO STRICT i FROM access.agent_identity_intent WHERE route=OLD.route AND account_id=OLD.account_id
     AND direction=OLD.direction AND receipt_id=OLD.receipt_id FOR SHARE;
   SELECT history_authority->'reference'->>'erasedRole',
     (history_authority->'reference'->'barrier'->>'accountId')::uuid INTO role,erased
     FROM core.agent_identity_work WHERE source_key=i.delivery_key FOR SHARE;
   PERFORM access.check_agent_identity_retention(i,role);
   IF (to_jsonb(NEW)-ARRAY['requested_by','decided_by','original_source','original_source_minimized']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['requested_by','decided_by','original_source','original_source_minimized']) OR
      NEW.requested_by IS DISTINCT FROM (CASE WHEN OLD.requested_by=erased THEN NULL ELSE OLD.requested_by END) OR
      NEW.decided_by IS DISTINCT FROM (CASE WHEN OLD.decided_by=erased THEN NULL ELSE OLD.decided_by END) OR
      NEW.original_source IS DISTINCT FROM (CASE WHEN role='subject' AND OLD.original_source IS NOT NULL
        THEN access.agent_identity_recovery_skeleton(OLD.original_source) ELSE OLD.original_source END) OR
      NEW.original_source_minimized IS DISTINCT FROM
        (OLD.original_source_minimized OR (role='subject' AND OLD.original_source IS NOT NULL)) THEN
     RAISE EXCEPTION 'identity recovery may minimize only the erased role' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME<>'agent_identity_intent' THEN
   RAISE EXCEPTION 'Account identity source requires receiving erasure custody' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['requested_by','decided_by','reason','intent','minimized']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['requested_by','decided_by','reason','intent','minimized']) THEN
   RAISE EXCEPTION 'Immutable account identity source' USING ERRCODE='23514'; END IF;
 SELECT history_authority->'reference'->>'erasedRole',
   (history_authority->'reference'->'barrier'->>'accountId')::uuid INTO role,erased
   FROM core.agent_identity_work WHERE source_key=OLD.delivery_key FOR SHARE;
 PERFORM access.check_agent_identity_retention(OLD,role);
 SELECT * INTO a FROM access.agent_identity_recovery WHERE route=OLD.route AND account_id=OLD.account_id
   AND direction=OLD.direction AND receipt_id=OLD.receipt_id FOR SHARE;
 IF FOUND AND ((role='subject' AND a.original_source IS NOT NULL AND NOT a.original_source_minimized) OR
    (role='requester' AND a.requested_by IS NOT NULL) OR (role='decider' AND a.decided_by IS NOT NULL)) THEN
   RAISE EXCEPTION 'identity recovery role transition is incomplete' USING ERRCODE='23514'; END IF;
 IF NEW.requested_by IS DISTINCT FROM (CASE WHEN OLD.requested_by=erased THEN NULL ELSE OLD.requested_by END) OR
    NEW.decided_by IS DISTINCT FROM (CASE WHEN OLD.decided_by=erased THEN NULL ELSE OLD.decided_by END) OR
    NEW.reason IS DISTINCT FROM (CASE WHEN OLD.decided_by=erased THEN NULL ELSE OLD.reason END) OR
    NEW.minimized IS DISTINCT FROM (OLD.minimized OR role='subject') OR
    NEW.intent IS DISTINCT FROM (CASE WHEN role='subject' THEN '{}'::jsonb ELSE OLD.intent END) THEN
   RAISE EXCEPTION 'identity retention may minimize only the erased personal role' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE access.agent_identity_intent ENABLE ALWAYS TRIGGER agent_identity_intent_immutable;
ALTER TABLE access.agent_identity_recovery ENABLE ALWAYS TRIGGER agent_identity_recovery_immutable;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Agent identity recovery retention is forward-only'; END $$;
