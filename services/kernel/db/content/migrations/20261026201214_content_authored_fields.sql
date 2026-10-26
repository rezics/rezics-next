-- migrate:up
-- Authored field documents retain their semantic candidate and account author independently of imported evidence.
CREATE TABLE content.authored_field (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  id uuid NOT NULL,
  subject uuid NOT NULL,
  candidate uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  author_account_id uuid NOT NULL,
  body bytea COMPRESSION lz4,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  licence text NOT NULL CHECK (length(licence) BETWEEN 1 AND 128),
  language text NOT NULL CHECK (length(language) BETWEEN 1 AND 128),
  availability text NOT NULL CHECK (availability IN ('available', 'erased')),
  recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (route, id),
  CHECK (route = get_byte(uuid_send(id), 10) * 256 + get_byte(uuid_send(id), 11)),
  CHECK (route = get_byte(uuid_send(subject), 10) * 256 + get_byte(uuid_send(subject), 11)),
  CHECK (route = get_byte(uuid_send(candidate), 10) * 256 + get_byte(uuid_send(candidate), 11)),
  CONSTRAINT authored_field_body_size CHECK (octet_length(body) <= 2097152),
  CONSTRAINT authored_field_body_digest CHECK (body_sha256 = sha256(body)),
  CHECK ((availability = 'available' AND body IS NOT NULL)
      OR (availability = 'erased' AND body IS NULL))
);

-- Preserve the author's identity and original digest when erasure clears the document bytes.
CREATE FUNCTION content.guard_authored_field() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authored document identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.id, NEW.subject, NEW.candidate, NEW.revision, NEW.author_account_id, NEW.body_sha256,
         NEW.licence, NEW.language, NEW.recorded_xid, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.id, OLD.subject, OLD.candidate, OLD.revision, OLD.author_account_id, OLD.body_sha256,
         OLD.licence, OLD.language, OLD.recorded_xid, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased' OR NEW.body IS NOT NULL THEN
    RAISE EXCEPTION 'Authored documents are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authored_field_immutable BEFORE UPDATE OR DELETE ON content.authored_field
FOR EACH ROW EXECUTE FUNCTION content.guard_authored_field();

-- migrate:down
-- Forward only: authored identity and authorship survive erasure.
