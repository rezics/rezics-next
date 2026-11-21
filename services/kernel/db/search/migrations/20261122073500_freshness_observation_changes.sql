-- migrate:up
ALTER TABLE search.freshness_positions ADD COLUMN change_xid xid8;
CREATE INDEX freshness_position_change ON search.freshness_positions(consumer, change_xid)
  WHERE change_xid IS NOT NULL;

-- Rows preceding the migration belong to every subsequent full observation.
-- A top-level xid makes writes inside savepoints visible according to their committing transaction.
CREATE FUNCTION search.mark_freshness_position_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW.consumer, NEW.shard, NEW.positions) IS DISTINCT FROM
      (OLD.consumer, OLD.shard, OLD.positions) THEN
    NEW.change_xid := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mark_freshness_position_change BEFORE INSERT OR UPDATE OF consumer, shard, positions
  ON search.freshness_positions FOR EACH ROW EXECUTE FUNCTION search.mark_freshness_position_change();
ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER mark_freshness_position_change;

CREATE TABLE search.freshness_observation_reset (
  singleton boolean PRIMARY KEY CHECK(singleton), revision uuid NOT NULL
);
INSERT INTO search.freshness_observation_reset VALUES (true, gen_random_uuid());
CREATE FUNCTION search.reset_freshness_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE search.freshness_observation_reset SET revision = gen_random_uuid() WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER freshness_observation_reset AFTER TRUNCATE ON search.freshness_positions
  FOR EACH STATEMENT EXECUTE FUNCTION search.reset_freshness_observation();
ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER freshness_observation_reset;
CREATE FUNCTION search.reset_deleted_freshness_points() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM removed) THEN
    UPDATE search.freshness_observation_reset SET revision = gen_random_uuid() WHERE singleton;
  END IF;
  RETURN NULL;
END;
$$;
-- A removed or moved key is absent from the changed-row index.
CREATE TRIGGER freshness_observation_removed AFTER DELETE ON search.freshness_positions REFERENCING OLD TABLE AS removed
  FOR EACH STATEMENT EXECUTE FUNCTION search.reset_deleted_freshness_points();
CREATE TRIGGER freshness_observation_moved AFTER UPDATE OF consumer,shard ON search.freshness_positions
  FOR EACH ROW WHEN ((OLD.consumer,OLD.shard) IS DISTINCT FROM (NEW.consumer,NEW.shard))
  EXECUTE FUNCTION search.reset_freshness_observation();
ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER freshness_observation_removed;
ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER freshness_observation_moved;

-- Inserts cannot replace an observed, present first envelope. Missing first envelopes are never reused.
CREATE TRIGGER freshness_observation_timestamp AFTER UPDATE OF partition_no,position,event_seq,recorded_at ON core.outbox
  FOR EACH STATEMENT EXECUTE FUNCTION search.reset_freshness_observation();
CREATE TRIGGER freshness_observation_removed AFTER DELETE ON core.outbox REFERENCING OLD TABLE AS removed
  FOR EACH STATEMENT EXECUTE FUNCTION search.reset_deleted_freshness_points();
CREATE TRIGGER freshness_observation_reset AFTER TRUNCATE ON core.outbox
  FOR EACH STATEMENT EXECUTE FUNCTION search.reset_freshness_observation();
ALTER TABLE core.outbox ENABLE ALWAYS TRIGGER freshness_observation_timestamp;
ALTER TABLE core.outbox ENABLE ALWAYS TRIGGER freshness_observation_removed;
ALTER TABLE core.outbox ENABLE ALWAYS TRIGGER freshness_observation_reset;

-- migrate:down
DROP TRIGGER freshness_observation_timestamp ON core.outbox;
DROP TRIGGER freshness_observation_removed ON core.outbox;
DROP TRIGGER freshness_observation_reset ON core.outbox;
DROP TRIGGER freshness_observation_removed ON search.freshness_positions;
DROP TRIGGER freshness_observation_moved ON search.freshness_positions;
DROP TRIGGER freshness_observation_reset ON search.freshness_positions;
DROP FUNCTION search.reset_deleted_freshness_points();
DROP FUNCTION search.reset_freshness_observation();
DROP TABLE search.freshness_observation_reset;
DROP TRIGGER mark_freshness_position_change ON search.freshness_positions;
DROP FUNCTION search.mark_freshness_position_change();
DROP INDEX search.freshness_position_change;
ALTER TABLE search.freshness_positions DROP COLUMN change_xid;
