-- migrate:up
ALTER TABLE community.realm
  ADD COLUMN discovery_epoch bigint NOT NULL DEFAULT 1 CHECK (discovery_epoch > 0),
  ADD COLUMN discovery_epoch_started_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- All native Realm head writers share this guard. Metadata edits retain the epoch.
CREATE FUNCTION community.advance_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.visibility, NEW.state, NEW.space_id) IS DISTINCT FROM
     (OLD.visibility, OLD.state, OLD.space_id) THEN
    NEW.discovery_epoch := OLD.discovery_epoch + 1;
    NEW.discovery_epoch_started_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_discovery_epoch BEFORE UPDATE ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.advance_realm_discovery_epoch();

-- migrate:down
