-- migrate:up

-- One slot per Realm and subject, in the Realm partition. History is append-only.
-- subject_revision_id stays null: subject point reads at T expose no revision id.
-- Semantic's subject read exposes a monotonic integer revision, not an identifier.
CREATE TABLE community.publication (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  publication_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('adopt', 'reject', 'withdraw')),
  predecessor uuid,
  subject_revision_id uuid,
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route, publication_id),
  UNIQUE (route, realm_id, publication_id),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm (route, realm_id),
  FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.publication (route, realm_id, publication_id),
  CHECK (predecessor <> publication_id),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11)),
  CHECK (route = get_byte(uuid_send(publication_id), 10) * 256 + get_byte(uuid_send(publication_id), 11)),
  CHECK (route = get_byte(uuid_send(predecessor), 10) * 256 + get_byte(uuid_send(predecessor), 11))
);

CREATE TABLE community.publication_head (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('adopt', 'reject', 'withdraw')),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (route, realm_id, subject_id),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm (route, realm_id),
  FOREIGN KEY (route, publication_id) REFERENCES community.publication (route, publication_id),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11)),
  CHECK (route = get_byte(uuid_send(publication_id), 10) * 256 + get_byte(uuid_send(publication_id), 11))
);

-- Adopted heads of one Realm, newest first, for a keyset seek. No count or offset.
CREATE INDEX publication_head_adopted_page
  ON community.publication_head (route, realm_id, published_at DESC, subject_id DESC)
  WHERE verdict = 'adopt';

CREATE FUNCTION community.guard_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Publication records are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER publication_immutable BEFORE UPDATE OR DELETE ON community.publication
FOR EACH ROW EXECUTE FUNCTION community.guard_publication();

CREATE FUNCTION community.guard_publication_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.subject_id)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.subject_id) THEN
    RAISE EXCEPTION 'Publication slot identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_head_identity BEFORE UPDATE ON community.publication_head
FOR EACH ROW EXECUTE FUNCTION community.guard_publication_head();

-- migrate:down
-- Forward only: publication history must survive rollback.
