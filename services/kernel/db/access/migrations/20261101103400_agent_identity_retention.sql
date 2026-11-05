-- migrate:up
-- Native defence for the narrow role transition. All authority comes from the
-- original immutable Source/History rows, never a setting, payload or cached verdict.
CREATE FUNCTION access.check_agent_identity_retention(i access.agent_identity_intent,p_role text)
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
 -- Recovered originals have additional native serializers. Their missing finite
 -- cut stays unknown; this migration does not invent historical associations.
 PERFORM 1 FROM access.agent_identity_recovery WHERE route=i.route AND account_id=i.account_id
   AND direction=i.direction AND receipt_id=i.receipt_id FOR SHARE;
 IF FOUND THEN RAISE EXCEPTION 'identity retention recovery copies unavailable' USING ERRCODE='23514'; END IF;
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
 -- The actual durable receiving row has its own full role digest, later proof,
 -- physical absence and current generation-2 locks; an SDK receipt alone cannot pass.
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
       ORDER BY account_route,account_id)::text,' ',''),'UTF8')),count(*),bool_and(minimizer_version=1) INTO role_hash,k,supported_roles FROM (
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
   -- Never delete consumer rows to obtain absence. Only an exact original mapped
   -- execution may reuse the already locked receiving closure. Wrapper/foreign
   -- executions retain their independent byte/writer obligations.
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
END $$;

CREATE OR REPLACE FUNCTION access.guard_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role text; erased uuid;
BEGIN
 IF TG_OP<>'UPDATE' OR TG_TABLE_NAME<>'agent_identity_intent' THEN
   RAISE EXCEPTION 'Account identity source requires receiving erasure custody' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['requested_by','decided_by','reason','intent','minimized']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['requested_by','decided_by','reason','intent','minimized']) THEN
   RAISE EXCEPTION 'Immutable account identity source' USING ERRCODE='23514'; END IF;
 SELECT history_authority->'reference'->>'erasedRole',
   (history_authority->'reference'->'barrier'->>'accountId')::uuid INTO role,erased
   FROM core.agent_identity_work WHERE source_key=OLD.delivery_key FOR SHARE;
 PERFORM access.check_agent_identity_retention(OLD,role);
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
-- Forward only: erased attribution cannot be restored from the technical skeleton.
