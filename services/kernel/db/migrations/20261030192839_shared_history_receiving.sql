-- migrate:up
CREATE TABLE core.history_registry (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
  gaps jsonb NOT NULL CHECK(jsonb_typeof(gaps)='array' AND octet_length(gaps::text)<=4096)
);
ALTER TABLE core.preference_history_job ADD COLUMN registry_generation bigint NOT NULL DEFAULT 0;
CREATE INDEX history_registry_redrive ON core.preference_history_job(registry_generation,job_id);
DROP INDEX core.preference_history_runnable;
CREATE INDEX preference_history_runnable ON core.preference_history_job(next_run,job_id)
  WHERE phase IN ('scan','verify');
-- Proof rows are issued only by physical minimizers. A later account sharing an already
-- minimized copy receives its own barrier proof without reintroducing the payload.
CREATE TABLE core.history_receiving_proof (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  account_route integer NOT NULL, account_id uuid NOT NULL,
  artifact_type text COLLATE "C" NOT NULL, locator bytea NOT NULL,
  barrier_version integer NOT NULL CHECK(barrier_version>0), barrier_at text NOT NULL,
  partition_epoch integer NOT NULL CHECK(partition_epoch>0),
  role_digest bytea NOT NULL CHECK(octet_length(role_digest)=32),
  PRIMARY KEY(partition_no,account_route,account_id,artifact_type,locator,partition_epoch),
  FOREIGN KEY(partition_no,account_route,account_id,artifact_type,locator)
    REFERENCES core.history_locator(partition_no,account_route,account_id,artifact_type,locator)
);
-- Custody evidence can only move forward. A proof cannot outlive a rewritten source scope.
CREATE FUNCTION core.history_receiving_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'history receiving proof is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER history_receiving_proof_immutable BEFORE UPDATE OR DELETE ON core.history_receiving_proof
 FOR EACH ROW EXECUTE FUNCTION core.history_receiving_proof_immutable();

-- Work readiness and Auth's committed copy proof are dependency changes, not timer guesses.
CREATE FUNCTION core.history_work_changed() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER history_work_changed AFTER UPDATE OF owner_ready,absence_verified ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.history_work_changed();
CREATE FUNCTION core.history_auth_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.phase='copies-erased' THEN PERFORM core.history_wake_account(NEW.route,NEW.account_id); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_auth_changed AFTER INSERT ON access.auth_history_proof
 FOR EACH ROW EXECUTE FUNCTION core.history_auth_changed();

-- A native marker is permanent even after the SDK's deduplication rows disappear.
CREATE FUNCTION core.history_payload_irreversible() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER history_receipt_irreversible BEFORE UPDATE ON core.receipt
 FOR EACH ROW EXECUTE FUNCTION core.history_payload_irreversible();
CREATE TRIGGER history_outbox_irreversible BEFORE UPDATE ON core.outbox
 FOR EACH ROW EXECUTE FUNCTION core.history_payload_irreversible();
CREATE FUNCTION core.history_retirement_irreversible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='retired' AND (NEW.state<>'retired' OR NEW.request IS NOT NULL OR NEW.scope IS NOT NULL
   OR NEW.request_digest<>OLD.request_digest OR NEW.owner IS DISTINCT FROM OLD.owner
   OR (OLD.absence_verified AND NOT NEW.absence_verified)) THEN
   RAISE EXCEPTION 'retired history work is sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_retirement_irreversible BEFORE UPDATE ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.history_retirement_irreversible();

-- migrate:down
-- Forward only. Neither physical minimization nor retirement can be undone.
