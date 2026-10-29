-- migrate:up
CREATE TABLE content.reaction_liked_version (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  actor_account_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (route, actor_account_id),
  CHECK (route = get_byte(uuid_send(actor_account_id), 10) * 256 + get_byte(uuid_send(actor_account_id), 11))
);

CREATE FUNCTION content.bump_reaction_liked_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_liked boolean := false;
  new_liked boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_liked := OLD.target_kind = 'subject' AND OLD.kind IN ('like', 'love');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_liked := NEW.target_kind = 'subject' AND NEW.kind IN ('like', 'love');
  END IF;
  IF TG_OP = 'UPDATE' AND
    ROW(OLD.route, OLD.actor_account_id, OLD.target_kind, OLD.target_route, OLD.target_id, OLD.kind)
      IS NOT DISTINCT FROM
    ROW(NEW.route, NEW.actor_account_id, NEW.target_kind, NEW.target_route, NEW.target_id, NEW.kind) THEN
    RETURN NULL;
  END IF;
  IF old_liked THEN
    INSERT INTO content.reaction_liked_version AS stored (route, actor_account_id, version)
    VALUES (OLD.route, OLD.actor_account_id, 1)
    ON CONFLICT (route, actor_account_id) DO UPDATE SET version = stored.version + 1;
  END IF;
  IF new_liked AND (NOT old_liked OR
    ROW(NEW.route, NEW.actor_account_id) IS DISTINCT FROM ROW(OLD.route, OLD.actor_account_id)) THEN
    INSERT INTO content.reaction_liked_version AS stored (route, actor_account_id, version)
    VALUES (NEW.route, NEW.actor_account_id, 1)
    ON CONFLICT (route, actor_account_id) DO UPDATE SET version = stored.version + 1;
  END IF;
  RETURN NULL;
END;
$$;

-- CREATE TRIGGER takes a lock conflicting with reaction writers. In this migration's
-- transaction it closes the cutover before any subsequent writer can commit unversioned.
CREATE TRIGGER reaction_liked_version
AFTER INSERT OR UPDATE OR DELETE ON content.reaction
FOR EACH ROW EXECUTE FUNCTION content.bump_reaction_liked_version();

-- migrate:down
DROP TRIGGER reaction_liked_version ON content.reaction;
DROP FUNCTION content.bump_reaction_liked_version();
DROP TABLE content.reaction_liked_version;
