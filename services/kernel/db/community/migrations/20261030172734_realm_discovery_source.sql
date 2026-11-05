-- migrate:up
ALTER TABLE community.realm
  ADD COLUMN discovery_epoch bigint NOT NULL DEFAULT 1 CHECK (discovery_epoch > 0),
  ADD COLUMN discovery_epoch_started_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- All native Realm head writers share this guard. Metadata edits retain the epoch.
CREATE FUNCTION community.advance_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.discovery_epoch_started_at := NEW.created_at;
  ELSIF (NEW.visibility, NEW.state, NEW.space_id) IS DISTINCT FROM
        (OLD.visibility, OLD.state, OLD.space_id) THEN
    NEW.discovery_epoch := OLD.discovery_epoch + 1;
    IF NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id THEN
      -- Native visibility changes append this exact revision at command T.
      SELECT r.created_at INTO STRICT NEW.discovery_epoch_started_at
      FROM community.realm_revision r
      WHERE r.route = NEW.route AND r.realm_id = NEW.realm_id
        AND r.revision_id = NEW.head_revision_id;
    ELSE
      NEW.discovery_epoch_started_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_discovery_epoch BEFORE INSERT OR UPDATE ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.advance_realm_discovery_epoch();

-- migrate:down
