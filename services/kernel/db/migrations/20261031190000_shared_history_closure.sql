-- migrate:up
-- Native jobs contain account/barrier progress. Cleanup never copies those values into DBOS.
ALTER TABLE core.preference_history_job
  DROP CONSTRAINT preference_history_job_phase_check,
  ADD CONSTRAINT preference_history_job_phase_check CHECK(phase IN ('scan','verify','pending','complete')),
  ADD COLUMN barrier_version integer,
  ADD COLUMN barrier_at text,
  ADD COLUMN registry_digest text,
  ADD COLUMN verify_partition integer NOT NULL DEFAULT 0 CHECK(verify_partition BETWEEN 0 AND 4096);
CREATE INDEX history_job_pending ON core.preference_history_job(job_id) WHERE phase='pending';
ALTER TABLE core.history_progress ADD COLUMN applicable boolean NOT NULL DEFAULT false;
CREATE INDEX history_progress_pending ON core.history_progress(account_route,account_id,barrier_id,store_kind,partition_no)
  WHERE state='pending';

-- A consumer transition or a supported owner explicitly redrives only the affected native job.
CREATE FUNCTION core.history_wake_account(p_route integer,p_account uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE core.preference_history_job SET phase='scan',scan_partition=0,scan_type=NULL,scan_locator=NULL,
   verify_partition=0,gap=NULL,next_run=now()
 WHERE account_route=p_route AND account_id=p_account AND phase='pending';
$$;
CREATE FUNCTION core.history_consumer_changed() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER history_consumer_changed AFTER UPDATE OF state ON core.history_event_consumer
 FOR EACH ROW EXECUTE FUNCTION core.history_consumer_changed();

-- migrate:down
-- Forward only: native closure proofs and minimized copies must not be reopened.
