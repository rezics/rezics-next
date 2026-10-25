-- migrate:up

-- Accounts and classification Contexts are external anchors. The Realm shares its Space route.
CREATE TABLE community.realm (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  space_id uuid NOT NULL,
  state text NOT NULL CHECK (state = 'active'),
  visibility text NOT NULL CHECK (visibility IN ('public', 'protected')),
  context_id uuid NOT NULL,
  head_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  creator uuid NOT NULL,
  PRIMARY KEY (route, realm_id),
  UNIQUE (route, space_id),
  FOREIGN KEY (route, space_id) REFERENCES community.space (route, space_id),
  CHECK (realm_id <> space_id),
  CHECK (route = get_byte(uuid_send(space_id), 10) * 256 + get_byte(uuid_send(space_id), 11)),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11)),
  CHECK (route = get_byte(uuid_send(head_revision_id), 10) * 256 + get_byte(uuid_send(head_revision_id), 11))
);

CREATE TABLE community.realm_revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  predecessor uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1024),
  summary text NOT NULL CHECK (char_length(summary) <= 4096),
  visibility text NOT NULL CHECK (visibility IN ('public', 'protected')),
  context_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  author uuid NOT NULL,
  PRIMARY KEY (route, revision_id),
  UNIQUE (route, realm_id, revision_id),
  UNIQUE (route, realm_id, revision_id, visibility, context_id),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm (route, realm_id),
  FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.realm_revision (route, realm_id, revision_id),
  CHECK (predecessor <> revision_id),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)),
  CHECK (route = get_byte(uuid_send(predecessor), 10) * 256 + get_byte(uuid_send(predecessor), 11))
);

-- The identity and its initial head are inserted in the same command transaction.
ALTER TABLE community.realm ADD CONSTRAINT realm_head_revision_fk
  FOREIGN KEY (route, realm_id, head_revision_id, visibility, context_id)
  REFERENCES community.realm_revision (route, realm_id, revision_id, visibility, context_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION community.guard_realm() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Realm identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_identity BEFORE UPDATE ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.guard_realm();

CREATE FUNCTION community.guard_realm_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Realm revisions are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER realm_revision_immutable BEFORE UPDATE OR DELETE ON community.realm_revision
FOR EACH ROW EXECUTE FUNCTION community.guard_realm_revision();

-- migrate:down
-- Forward only: stable identities and exact revision history must survive rollback.
