-- migrate:up
-- Native consumer readiness is not a public cleanup flag. The pinned SDK has no
-- supported permanent per-workflow writer fence, and Semantic's only durable
-- source-consumer disposition is retained. Neither can authorize retirement.
CREATE FUNCTION core.guard_agent_identity_sdk_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.owner='access.agent-identity' THEN
     RAISE EXCEPTION 'native identity SDK retirement custody is permanent' USING ERRCODE='23514';
   END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.owner='access.agent-identity' AND
    (NEW.owner,NEW.work_id,NEW.partition_no,NEW.request_digest,NEW.source_partition,NEW.source_transaction) IS DISTINCT FROM
    (OLD.owner,OLD.work_id,OLD.partition_no,OLD.request_digest,OLD.source_partition,OLD.source_transaction) THEN
   RAISE EXCEPTION 'native identity SDK retirement binding is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.owner='access.agent-identity' AND
    (NEW.owner_ready OR NEW.absence_verified OR NEW.state<>'pending' OR NEW.retired_at IS NOT NULL) THEN
   -- No supported durable terminal-transfer / SDK-fence locator exists to join and
   -- verify. Keep this transition closed instead of trusting a TS result or status.
   RAISE EXCEPTION 'identity SDK retirement requires durable source transfer and permanent native writer fence'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_agent_identity_retirement_guard BEFORE INSERT OR UPDATE OR DELETE ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_sdk_retirement();

-- migrate:down
DROP TRIGGER history_agent_identity_retirement_guard ON core.history_work;
DROP FUNCTION core.guard_agent_identity_sdk_retirement();
