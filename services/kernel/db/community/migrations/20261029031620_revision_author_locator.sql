-- migrate:up
-- The author's partition is the bounded entry point; owner revisions stay on their original routes.
CREATE TABLE community.revision_locator (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('realm', 'space')),
  owner_route integer NOT NULL CHECK (owner_route BETWEEN 0 AND 65535),
  owner_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, kind, owner_route, owner_id, revision_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (owner_route = get_byte(uuid_send(owner_id), 10) * 256 + get_byte(uuid_send(owner_id), 11)),
  CHECK (owner_route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11))
);

INSERT INTO community.revision_locator
SELECT get_byte(uuid_send(author), 10) * 256 + get_byte(uuid_send(author), 11),
       author, 'realm', route, realm_id, revision_id FROM community.realm_revision
UNION ALL
SELECT get_byte(uuid_send(author), 10) * 256 + get_byte(uuid_send(author), 11),
       author, 'space', route, space_id, revision_id FROM community.space_revision;

-- Public input still requires a title. Only the narrow archive-erasure exception below may clear it.
ALTER TABLE community.realm_revision DROP CONSTRAINT realm_revision_title_check;
ALTER TABLE community.realm_revision ADD CONSTRAINT realm_revision_title_check
  CHECK (char_length(title) BETWEEN 0 AND 1024);
ALTER TABLE community.space_revision DROP CONSTRAINT space_revision_title_check;
ALTER TABLE community.space_revision ADD CONSTRAINT space_revision_title_check
  CHECK (char_length(title) BETWEEN 0 AND 1024);

-- Reserve one smaller replacement tuple per revision for archive erasure. This
-- keeps clears on the original heap page (HOT), rather than rewriting every
-- revision index as successive erasure pages exhaust incidental free space.
ALTER TABLE community.realm_revision SET (fillfactor = 50);
ALTER TABLE community.space_revision SET (fillfactor = 50);

CREATE OR REPLACE FUNCTION community.guard_realm_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('community.erasure_account', true) = OLD.author::text
       AND NEW.title = '' AND NEW.summary = ''
       AND (to_jsonb(NEW) - 'title' - 'summary') = (to_jsonb(OLD) - 'title' - 'summary')
       AND EXISTS (SELECT 1 FROM community.realm
                   WHERE route = OLD.route AND realm_id = OLD.realm_id
                     AND head_revision_id <> OLD.revision_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Realm revisions are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION community.guard_space_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('community.erasure_account', true) = OLD.author::text
       AND NEW.title = '' AND NEW.summary = ''
       AND (to_jsonb(NEW) - 'title' - 'summary') = (to_jsonb(OLD) - 'title' - 'summary')
       AND EXISTS (SELECT 1 FROM community.space
                   WHERE route = OLD.route AND space_id = OLD.space_id
                     AND head_revision_id <> OLD.revision_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Space revisions are append-only' USING ERRCODE = '23514';
END;
$$;

-- migrate:down
-- Forward only: erasure cannot restore archived prose.
