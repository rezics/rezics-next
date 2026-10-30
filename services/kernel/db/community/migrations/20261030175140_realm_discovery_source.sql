-- migrate:up
ALTER TABLE community.realm ADD COLUMN discovery_generation bigint NOT NULL DEFAULT 1
  CHECK (discovery_generation > 0);

CREATE TABLE community.realm_discovery_fence (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL CHECK (realm_epoch > 0),
  source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535),
  intent text NOT NULL CHECK (intent ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  fence_generation bigint NOT NULL CHECK (fence_generation > 0),
  outcome text CHECK (outcome IN ('applied','aborted')),
  outcome_transaction_id uuid,
  PRIMARY KEY (route, realm_id, realm_epoch, source_route, intent, generation),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id),
  CHECK ((outcome IS NULL) = (outcome_transaction_id IS NULL))
);
CREATE INDEX realm_discovery_fence_pending ON community.realm_discovery_fence
  (route, realm_id, realm_epoch) WHERE outcome IS NULL;

-- Absolute versioned source state, ready for Community's later bounded bucket consumer.
CREATE TABLE community.realm_discovery_source (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL,
  source_route integer NOT NULL,
  thread_id uuid NOT NULL,
  board_id uuid NOT NULL,
  creation_day date NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  contributing boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, source_route, thread_id)
);
CREATE TABLE community.realm_discovery_board (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL,
  board_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  published boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, board_id)
);

CREATE FUNCTION community.fence_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.visibility, NEW.state, NEW.space_id) IS DISTINCT FROM
     (OLD.visibility, OLD.state, OLD.space_id) THEN
    NEW.discovery_generation := OLD.discovery_generation + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_discovery_generation BEFORE UPDATE ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.fence_realm_discovery_epoch();


-- A Space carries at most one Realm in the same route (the unique native slot).
-- State changes invalidate that binding atomically, without a descendant scan.
CREATE FUNCTION community.fence_space_realm_discovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    UPDATE community.realm SET discovery_epoch = discovery_epoch + 1,
      discovery_epoch_started_at = clock_timestamp(), discovery_generation = discovery_generation + 1
    WHERE route = NEW.route AND space_id = NEW.space_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_realm_discovery_generation AFTER UPDATE ON community.space
FOR EACH ROW EXECUTE FUNCTION community.fence_space_realm_discovery();

-- migrate:down
