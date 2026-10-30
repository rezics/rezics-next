-- migrate:up
-- No historical source backfill: only committed native changes enter this log.
ALTER TABLE community.realm DROP CONSTRAINT realm_discovery_generation_check;
ALTER TABLE community.realm ALTER COLUMN discovery_generation SET DEFAULT 0;
ALTER TABLE community.realm ADD CHECK (discovery_generation >= 0);
ALTER TABLE community.realm_discovery_source ADD COLUMN space_id uuid;

CREATE TABLE community.realm_discovery_change (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL CHECK (realm_epoch > 0),
  generation bigint NOT NULL CHECK (generation > 0),
  previous_generation bigint NOT NULL CHECK (previous_generation >= 0),
  transaction_id uuid NOT NULL,
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND value->>'kind' IN ('thread','board','epoch','gate')),
  PRIMARY KEY (route, realm_id, generation),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id),
  CHECK (generation = previous_generation + 1)
);

CREATE FUNCTION community.immutable_realm_discovery_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Realm discovery changes are append-only';
END;
$$;
CREATE TRIGGER realm_discovery_change_immutable BEFORE UPDATE OR DELETE ON community.realm_discovery_change
FOR EACH ROW EXECUTE FUNCTION community.immutable_realm_discovery_change();

-- The generation is owned by the log alone. Epoch guards still change the epoch
-- immediately; their deferred log entry and generation commit atomically with it.
CREATE OR REPLACE FUNCTION community.fence_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION community.fence_space_realm_discovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    UPDATE community.realm SET discovery_epoch = discovery_epoch + 1,
      discovery_epoch_started_at = clock_timestamp()
    WHERE route = NEW.route AND space_id = NEW.space_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION community.append_realm_discovery_change(
  source_route integer, source_realm uuid, source_epoch bigint, change_value jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  prior bigint;
  native_transaction uuid;
BEGIN
  -- Installed only by bindRealmDiscoveryCommand's native executor callback.
  native_transaction := NULLIF(current_setting('rezics.discovery_transaction_id', true), '')::uuid;
  IF native_transaction IS NULL THEN
    RAISE EXCEPTION 'Realm discovery native command binding unavailable';
  END IF;
  SELECT discovery_generation INTO STRICT prior FROM community.realm
    WHERE route = source_route AND realm_id = source_realm FOR UPDATE;
  INSERT INTO community.realm_discovery_change
    (route,realm_id,realm_epoch,generation,previous_generation,transaction_id,value)
    VALUES (source_route,source_realm,source_epoch,prior+1,prior,native_transaction,change_value);
  UPDATE community.realm SET discovery_generation = prior+1
    WHERE route = source_route AND realm_id = source_realm;
END;
$$;

CREATE FUNCTION community.log_realm_discovery_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.space_id IS NULL THEN
    RAISE EXCEPTION 'Realm discovery original Space binding unavailable';
  END IF;
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.realm_epoch,
    jsonb_build_object('kind','thread','source',jsonb_build_object(
      'realmId',NEW.realm_id,'realmEpoch',NEW.realm_epoch::text,'spaceId',NEW.space_id,
      'boardId',NEW.board_id,'threadId',NEW.thread_id,'sourceRoute',NEW.source_route,
      'creationDay',to_char(NEW.creation_day,'YYYY-MM-DD'),'sourceVersion',NEW.source_version::text,
      'contributing',NEW.contributing)));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_thread_log AFTER INSERT OR UPDATE ON community.realm_discovery_source
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_thread();

CREATE FUNCTION community.log_realm_discovery_board() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.realm_epoch,
    jsonb_build_object('kind','board','boardId',NEW.board_id,
      'sourceVersion',NEW.source_version::text,'published',NEW.published));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_board_log AFTER INSERT OR UPDATE ON community.realm_discovery_board
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_board();

CREATE FUNCTION community.log_realm_discovery_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_epoch bigint;
  settled boolean;
BEGIN
  SELECT discovery_epoch INTO STRICT current_epoch FROM community.realm
    WHERE route = NEW.route AND realm_id = NEW.realm_id FOR UPDATE;
  SELECT NOT EXISTS (SELECT 1 FROM community.realm_discovery_fence
    WHERE route = NEW.route AND realm_id = NEW.realm_id AND realm_epoch = current_epoch AND outcome IS NULL)
    INTO settled;
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, current_epoch,
    jsonb_build_object('kind','gate','settled',settled));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_gate_log AFTER INSERT OR UPDATE ON community.realm_discovery_fence
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_gate();

CREATE FUNCTION community.log_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.discovery_epoch,
    jsonb_build_object('kind','epoch'));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_epoch_log AFTER UPDATE ON community.realm
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.discovery_epoch IS DISTINCT FROM NEW.discovery_epoch)
EXECUTE FUNCTION community.log_realm_discovery_epoch();

-- migrate:down
