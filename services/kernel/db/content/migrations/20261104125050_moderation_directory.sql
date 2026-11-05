-- migrate:up

-- Install the live writer before capturing the finite baseline. Registration is
-- native Content resource registration, never a copy of grants or memberships.
LOCK TABLE content.board IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE content.moderation_directory_install (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  complete boolean NOT NULL DEFAULT false,
  cut_route integer NOT NULL,
  cut_id uuid NOT NULL,
  after_route integer NOT NULL DEFAULT -1,
  after_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  CHECK (cut_route BETWEEN -1 AND 65535),
  CHECK (after_route BETWEEN -1 AND 65535)
);

CREATE TABLE content.moderation_directory_reference (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  realm_id uuid,
  PRIMARY KEY (route, board_id),
  CHECK (route = get_byte(uuid_send(board_id),10)*256 + get_byte(uuid_send(board_id),11))
);
CREATE INDEX moderation_directory_reference_realm
  ON content.moderation_directory_reference (realm_id, route, board_id);

INSERT INTO content.moderation_directory_install(singleton,cut_route,cut_id)
SELECT true, coalesce(last.route,-1), coalesce(last.board_id,'00000000-0000-0000-0000-000000000000'::uuid)
FROM (VALUES (true)) seed(singleton)
LEFT JOIN LATERAL (
  SELECT route,board_id FROM content.board ORDER BY route DESC,board_id DESC LIMIT 1
) last ON true;

CREATE FUNCTION content.register_moderation_directory_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM content.moderation_directory_install WHERE singleton FOR UPDATE;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM content.moderation_directory_reference WHERE route=OLD.route AND board_id=OLD.board_id;
  ELSE
    IF TG_OP = 'UPDATE' AND ROW(OLD.route,OLD.board_id) IS DISTINCT FROM ROW(NEW.route,NEW.board_id) THEN
      DELETE FROM content.moderation_directory_reference WHERE route=OLD.route AND board_id=OLD.board_id;
    END IF;
    INSERT INTO content.moderation_directory_reference(route,board_id,realm_id)
    VALUES(NEW.route,NEW.board_id,NEW.realm_id)
    ON CONFLICT(route,board_id) DO UPDATE SET realm_id=EXCLUDED.realm_id;
  END IF;
  -- Labels stay in their owner. Even a same-key replacement retires frontiers.
  UPDATE content.moderation_directory_install SET generation=generation+1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderation_directory_registration
AFTER INSERT OR UPDATE OR DELETE ON content.board
FOR EACH ROW EXECUTE FUNCTION content.register_moderation_directory_reference();

-- migrate:down
DROP TRIGGER moderation_directory_registration ON content.board;
DROP FUNCTION content.register_moderation_directory_reference();
DROP TABLE content.moderation_directory_reference;
DROP TABLE content.moderation_directory_install;
