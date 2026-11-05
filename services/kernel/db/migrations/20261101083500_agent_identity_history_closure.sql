-- migrate:up
-- Authority remains on the original association. Neither field is a new receipt ledger.
ALTER TABLE core.agent_identity_work
 ADD COLUMN history_authority jsonb CHECK(octet_length(history_authority::text)<=32768),
 ADD COLUMN sdk_readiness jsonb CHECK(octet_length(sdk_readiness::text)<=65536),
 ADD COLUMN sdk_closure jsonb CHECK(octet_length(sdk_closure::text)<=8192),
 ADD CONSTRAINT agent_identity_history_readiness_pair CHECK((history_authority IS NULL)=(sdk_readiness IS NULL)),
 ADD CONSTRAINT agent_identity_history_closure_pair CHECK(sdk_closure IS NULL OR sdk_retirement_receipt IS NOT NULL);

-- Calls the ORIGINAL producer functions. No Source or SDK SQL is installed here.
CREATE FUNCTION core.check_agent_identity_history(
 p_custody uuid,p_binding jsonb,p_authority jsonb,p_writer jsonb,p_phase text
) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE FUNCTION core.check_agent_identity_history_absence(p_custody uuid) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION core.guard_agent_identity_work() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION core.guard_agent_identity_sdk_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE FUNCTION core.guard_agent_identity_history_receiving() RETURNS trigger LANGUAGE plpgsql AS $$
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
END; $$;
CREATE TRIGGER history_agent_identity_locator_guard BEFORE UPDATE OF state,proof_barrier ON core.history_locator
 FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_history_receiving();
CREATE TRIGGER history_agent_identity_receiving_guard BEFORE INSERT ON core.history_receiving_proof
 FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_history_receiving();
CREATE TRIGGER agent_identity_history_initial BEFORE INSERT ON core.agent_identity_work
 FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_work();
ALTER TABLE core.agent_identity_work ENABLE ALWAYS TRIGGER agent_identity_history_initial;
ALTER TABLE core.agent_identity_work ENABLE ALWAYS TRIGGER agent_identity_work_immutable;
ALTER TABLE core.agent_identity_work_source ENABLE ALWAYS TRIGGER agent_identity_work_source_immutable;
ALTER TABLE core.history_work ENABLE ALWAYS TRIGGER history_agent_identity_retirement_guard;
ALTER TABLE core.history_locator ENABLE ALWAYS TRIGGER history_agent_identity_locator_guard;
ALTER TABLE core.history_receiving_proof ENABLE ALWAYS TRIGGER history_agent_identity_receiving_guard;
-- migrate:down
-- Forward only: readiness, closure and original writer identity are permanent.
