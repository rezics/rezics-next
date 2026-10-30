-- migrate:up
-- Owner-issued binary identity/revision; no Semantic member rows or authority are stored here.
CREATE TABLE core.record_history_source_set (
  source_partition integer NOT NULL REFERENCES core.partition(partition_no),
  set_locator bytea NOT NULL CHECK(octet_length(set_locator) BETWEEN 1 AND 256),
  set_revision bytea NOT NULL CHECK(octet_length(set_revision) BETWEEN 1 AND 256),
  original_transaction uuid NOT NULL,
  original_position bigint CHECK(original_position>=0),
  member_count integer NOT NULL CHECK(member_count BETWEEN 1 AND 512),
  producer_version integer NOT NULL CHECK(producer_version=1),
  PRIMARY KEY(source_partition,set_locator,set_revision),
  UNIQUE(source_partition,original_transaction)
);
CREATE INDEX record_history_source_set_original ON core.record_history_source_set(source_partition,original_transaction)
 WHERE original_position IS NULL;
CREATE TABLE core.record_history_source_set_copy (
  source_partition integer NOT NULL,
  set_locator bytea NOT NULL CHECK(octet_length(set_locator) BETWEEN 1 AND 256),
  set_revision bytea NOT NULL CHECK(octet_length(set_revision) BETWEEN 1 AND 256),
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  artifact_type text COLLATE "C" NOT NULL CHECK(artifact_type IN ('command-receipt/v1','outbox-event/v1','durable-work/v1')),
  locator bytea NOT NULL CHECK(octet_length(locator) BETWEEN 1 AND 256),
  original_transaction uuid NOT NULL,
  original_position bigint CHECK(original_position>=0),
  producer_version integer NOT NULL CHECK(producer_version=1),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','minimized')),
  next_attempt timestamptz NOT NULL DEFAULT now(),
  gap text CHECK(octet_length(gap)<=256),
  PRIMARY KEY(source_partition,set_locator,set_revision,partition_no,artifact_type,locator),
  UNIQUE(partition_no,artifact_type,locator)
);
CREATE INDEX record_history_source_set_copy_original ON core.record_history_source_set_copy(partition_no,original_transaction)
 WHERE original_position IS NULL;
CREATE INDEX record_history_source_set_copy_pending
 ON core.record_history_source_set_copy(source_partition,set_locator,set_revision,next_attempt,partition_no,artifact_type,locator)
 WHERE state='pending' OR gap='record-source-native-release-pending';
CREATE FUNCTION core.record_history_preserve_source_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['original_position','state','next_attempt','gap'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['original_position','state','next_attempt','gap'])
   OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position)
   OR (to_jsonb(OLD)->>'state'='minimized' AND to_jsonb(NEW)->>'state'<>'minimized') THEN
   RAISE EXCEPTION 'record history source set is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_history_preserve_source_set BEFORE UPDATE OR DELETE ON core.record_history_source_set
 FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_source_set();
CREATE TRIGGER record_history_preserve_source_set_copy BEFORE UPDATE OR DELETE ON core.record_history_source_set_copy
 FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_source_set();
CREATE INDEX record_history_receiving_pending ON core.record_history_locator(source_key,next_attempt,partition_no,artifact_type,locator)
 WHERE state='pending' OR gap='record-source-native-release-pending';
-- Resumable native member-to-set discovery, not a copy of a member vector.
ALTER TABLE core.record_history_purge ADD COLUMN set_frontier bytea CHECK(set_frontier IS NULL OR octet_length(set_frontier) BETWEEN 1 AND 256),
 ADD COLUMN set_inventory_sealed boolean NOT NULL DEFAULT false;
CREATE TABLE core.record_history_purge_set (
 source_key text COLLATE "C" NOT NULL,
 deletion_generation uuid NOT NULL,
 source_partition integer NOT NULL,
 set_locator bytea NOT NULL,
 set_revision bytea NOT NULL,
 original_transaction uuid NOT NULL,
 member_count integer NOT NULL CHECK(member_count BETWEEN 1 AND 512),
 next_attempt timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_key,deletion_generation,source_partition,set_locator,set_revision),
 FOREIGN KEY(source_key,deletion_generation) REFERENCES core.record_history_purge(source_key,deletion_generation)
);
CREATE INDEX record_history_purge_set_runnable
 ON core.record_history_purge_set(source_key,deletion_generation,next_attempt,source_partition,set_locator,set_revision);
CREATE FUNCTION core.record_history_preserve_purge_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'next_attempt') IS DISTINCT FROM (to_jsonb(OLD)-'next_attempt') THEN
   RAISE EXCEPTION 'record history native set enrollment is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_history_preserve_purge_set BEFORE UPDATE OR DELETE ON core.record_history_purge_set
 FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_purge_set();
-- migrate:down
-- Forward only: preserve original and receiving provenance after payload minimization.
