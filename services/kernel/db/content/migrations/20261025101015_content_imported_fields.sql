-- migrate:up
-- One immutable source summary per exact document ID. Selection, adoption and
-- publication remain semantic authority; source fences retain their own home.
CREATE TABLE content.imported_field (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  id uuid NOT NULL,
  subject uuid NOT NULL,
  candidate uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  body bytea COMPRESSION lz4,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  rights jsonb NOT NULL CHECK (jsonb_typeof(rights) = 'object'),
  language text NOT NULL CHECK (length(language) BETWEEN 1 AND 128),
  availability text NOT NULL CHECK (availability IN ('available', 'erased')),
  recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (route, id),
  CHECK (route = get_byte(uuid_send(id), 10) * 256 + get_byte(uuid_send(id), 11)),
  CHECK (route = get_byte(uuid_send(subject), 10) * 256 + get_byte(uuid_send(subject), 11)),
  CHECK (route = get_byte(uuid_send(candidate), 10) * 256 + get_byte(uuid_send(candidate), 11)),
  CONSTRAINT imported_field_body_size CHECK (octet_length(body) <= 2097152),
  CONSTRAINT imported_field_body_digest CHECK (body_sha256 = sha256(body)),
  CHECK ((availability = 'available' AND body IS NOT NULL)
      OR (availability = 'erased' AND body IS NULL)),
  CHECK ((source ->> 'field_group') IS NOT DISTINCT FROM 'summary'),
  CHECK (source ? 'references' AND jsonb_typeof(source -> 'references') = 'array' AND jsonb_array_length(source -> 'references') <= 128)
);

-- Keep the original bytes' digest and all evidence even after physical erasure.
CREATE FUNCTION content.guard_imported_field() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Imported document identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.id, NEW.subject, NEW.candidate, NEW.revision, NEW.body_sha256, NEW.source, NEW.rights,
         NEW.language, NEW.recorded_xid, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.id, OLD.subject, OLD.candidate, OLD.revision, OLD.body_sha256, OLD.source, OLD.rights,
         OLD.language, OLD.recorded_xid, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased' OR NEW.body IS NOT NULL THEN
    RAISE EXCEPTION 'Imported documents are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imported_field_immutable BEFORE UPDATE OR DELETE ON content.imported_field
FOR EACH ROW EXECUTE FUNCTION content.guard_imported_field();

-- migrate:down
-- Forward only: exact document identity and provenance survive erasure.
