-- migrate:up
-- Kernel metadata binds the original SDK receipt without implementing SDK storage or guards.
-- Source terminal/technical-undo transfer is still unavailable: retirement guards stay closed.
ALTER TABLE core.agent_identity_work ADD COLUMN sdk_retirement_receipt jsonb;
ALTER TABLE core.agent_identity_work ADD CONSTRAINT agent_identity_work_sdk_retirement_receipt_check CHECK (((sdk_retirement_receipt IS NULL) OR ((octet_length((sdk_retirement_receipt)::text) <= 16384) AND (jsonb_typeof(sdk_retirement_receipt) = 'object'::text) AND (jsonb_typeof((sdk_retirement_receipt -> 'fence'::text)) = 'object'::text) AND ((sdk_retirement_receipt -> 'fence'::text) ?& ARRAY['workflowID'::text, 'generation'::text, 'closureID'::text, 'closedAt'::text]))));

CREATE OR REPLACE FUNCTION core.guard_agent_identity_work() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native identity SDK custody is permanent' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='agent_identity_work_source' THEN
   RAISE EXCEPTION 'native identity SDK source intent is immutable' USING ERRCODE='23514';
 END IF;
 IF    (to_jsonb(NEW)-ARRAY['source','creation_captured','request_digest','sdk_retirement_receipt']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['source','creation_captured','request_digest','sdk_retirement_receipt']) OR
   (OLD.request_digest IS NOT NULL AND NEW.request_digest IS DISTINCT FROM OLD.request_digest) OR
   (OLD.source IS NOT NULL AND NEW.source IS DISTINCT FROM OLD.source) OR
   (OLD.creation_captured AND NOT NEW.creation_captured) OR
   (OLD.sdk_retirement_receipt IS NOT NULL AND NEW.sdk_retirement_receipt IS DISTINCT FROM OLD.sdk_retirement_receipt) THEN
   RAISE EXCEPTION 'native identity SDK custody is immutable' USING ERRCODE='23514';
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
 RETURN NEW;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION core.guard_agent_identity_work() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native identity SDK custody is permanent' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='agent_identity_work_source' THEN
   RAISE EXCEPTION 'native identity SDK source intent is immutable' USING ERRCODE='23514';
 END IF;
 IF    (to_jsonb(NEW)-ARRAY['source','creation_captured','request_digest']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['source','creation_captured','request_digest']) OR
   (OLD.request_digest IS NOT NULL AND NEW.request_digest IS DISTINCT FROM OLD.request_digest) OR
   (OLD.source IS NOT NULL AND NEW.source IS DISTINCT FROM OLD.source) OR
   (OLD.creation_captured AND NOT NEW.creation_captured) THEN
   RAISE EXCEPTION 'native identity SDK custody is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
ALTER TABLE core.agent_identity_work DROP COLUMN sdk_retirement_receipt;
