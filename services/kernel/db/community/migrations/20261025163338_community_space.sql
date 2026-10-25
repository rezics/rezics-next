-- migrate:up
CREATE SCHEMA community;

-- Account identities are external anchors and need not share the Space route.
CREATE TABLE community.space (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  space_id uuid NOT NULL,
  state text NOT NULL CHECK (state = 'active'),
  head_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  creator uuid NOT NULL,
  PRIMARY KEY (route, space_id),
  CHECK (route = get_byte(uuid_send(space_id), 10) * 256 + get_byte(uuid_send(space_id), 11)),
  CHECK (route = get_byte(uuid_send(head_revision_id), 10) * 256 + get_byte(uuid_send(head_revision_id), 11))
);

CREATE TABLE community.space_revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  space_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  predecessor uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1024),
  summary text NOT NULL CHECK (char_length(summary) <= 4096),
  created_at timestamptz NOT NULL,
  author uuid NOT NULL,
  PRIMARY KEY (route, revision_id),
  UNIQUE (route, space_id, revision_id),
  FOREIGN KEY (route, space_id) REFERENCES community.space (route, space_id),
  FOREIGN KEY (route, space_id, predecessor) REFERENCES community.space_revision (route, space_id, revision_id),
  CHECK (predecessor <> revision_id),
  CHECK (route = get_byte(uuid_send(space_id), 10) * 256 + get_byte(uuid_send(space_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)),
  CHECK (route = get_byte(uuid_send(predecessor), 10) * 256 + get_byte(uuid_send(predecessor), 11))
);

-- The identity and its initial head are inserted in the same command transaction.
ALTER TABLE community.space ADD CONSTRAINT space_head_revision_fk
  FOREIGN KEY (route, space_id, head_revision_id)
  REFERENCES community.space_revision (route, space_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION community.guard_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Space identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_identity BEFORE UPDATE ON community.space
FOR EACH ROW EXECUTE FUNCTION community.guard_space();

CREATE FUNCTION community.guard_space_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Space revisions are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER space_revision_immutable BEFORE UPDATE OR DELETE ON community.space_revision
FOR EACH ROW EXECUTE FUNCTION community.guard_space_revision();

-- migrate:down
-- Forward only: stable identities and exact revision history must survive rollback.
