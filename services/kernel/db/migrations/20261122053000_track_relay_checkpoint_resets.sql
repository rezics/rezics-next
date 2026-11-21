-- migrate:up
CREATE TABLE core.relay_checkpoint_reset (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision xid8 NOT NULL
);
INSERT INTO core.relay_checkpoint_reset VALUES (true, pg_current_xact_id());

CREATE FUNCTION core.invalidate_relay_checkpoints() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE core.relay_checkpoint_reset SET revision = pg_current_xact_id() WHERE singleton;
  RETURN NULL;
END $$;

CREATE TRIGGER relay_checkpoint_delete AFTER DELETE OR TRUNCATE ON core.consumer_checkpoint
FOR EACH STATEMENT EXECUTE FUNCTION core.invalidate_relay_checkpoints();
CREATE TRIGGER relay_checkpoint_rewind AFTER UPDATE OF partition_no, consumer, position ON core.consumer_checkpoint
FOR EACH ROW WHEN (
  (OLD.partition_no, OLD.consumer) IS DISTINCT FROM (NEW.partition_no, NEW.consumer)
  OR NEW.position < OLD.position
) EXECUTE FUNCTION core.invalidate_relay_checkpoints();

-- migrate:down
DROP TRIGGER relay_checkpoint_rewind ON core.consumer_checkpoint;
DROP TRIGGER relay_checkpoint_delete ON core.consumer_checkpoint;
DROP FUNCTION core.invalidate_relay_checkpoints();
DROP TABLE core.relay_checkpoint_reset;
