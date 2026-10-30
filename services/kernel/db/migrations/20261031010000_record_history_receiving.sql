-- migrate:up
-- Resource-led ownership, independent of the existing account-role union and its barrier proofs.
-- A converted command proves only its own copies. No historical completeness is inferred.
CREATE TABLE core.record_history_locator (
  source_key text COLLATE "C" NOT NULL CHECK(octet_length(source_key) BETWEEN 1 AND 256),
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  artifact_type text COLLATE "C" NOT NULL CHECK(artifact_type IN ('command-receipt/v1','outbox-event/v1','durable-work/v1')),
  locator bytea NOT NULL CHECK(octet_length(locator) BETWEEN 1 AND 256),
  original_transaction uuid NOT NULL,
  original_position bigint CHECK(original_position>=0),
  producer_version integer NOT NULL CHECK(producer_version=1),
  coverage text NOT NULL DEFAULT 'partial' CHECK(coverage='partial'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','minimized')),
  next_attempt timestamptz NOT NULL DEFAULT now(),
  gap text CHECK(octet_length(gap)<=256),
  PRIMARY KEY(source_key,partition_no,artifact_type,locator)
);
CREATE INDEX record_history_copy ON core.record_history_locator(partition_no,artifact_type,locator,source_key);
CREATE INDEX record_history_original ON core.record_history_locator(partition_no,original_transaction)
  WHERE original_position IS NULL;
CREATE INDEX record_history_pending ON core.record_history_locator(source_key,next_attempt,partition_no,artifact_type,locator)
  WHERE state='pending';
CREATE FUNCTION core.record_history_preserve_copy() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER record_history_preserve_copy BEFORE UPDATE OR DELETE ON core.record_history_locator
 FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_copy();

-- Native restart locator only, never an authority, source JSON snapshot, actor or account barrier.
CREATE TABLE core.record_history_purge (
  source_key text COLLATE "C" NOT NULL,
  deletion_generation uuid NOT NULL,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  subject_id uuid NOT NULL, candidate_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  document_id uuid,
  gap text NOT NULL DEFAULT 'record-original-producer-coverage-unsealed' CHECK(octet_length(gap)<=256),
  next_run timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_key,deletion_generation)
);
CREATE INDEX record_history_purge_runnable ON core.record_history_purge(next_run,source_key,deletion_generation);
-- migrate:down
-- Forward only: minimized native payloads cannot be restored.
