-- migrate:up
-- Source tuple homes survive subject merges. Only identity and current fence
-- metadata live here; this table neither grants permission nor stores resources.
CREATE TABLE content.source_fences (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  source text COLLATE "C" NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  external_id text COLLATE "C" NOT NULL CHECK (octet_length(external_id) BETWEEN 1 AND 1024
    AND external_id !~ '[\u0001-\u001f\u007f-\u009f]'),
  field_group text COLLATE "C" NOT NULL CHECK (field_group IN ('facts', 'summary', 'cover')),
  taken_down boolean NOT NULL,
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  PRIMARY KEY (route, source, external_id, field_group)
);

CREATE FUNCTION content.guard_source_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Source fence identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.source, NEW.external_id, NEW.field_group)
      IS DISTINCT FROM ROW(OLD.route, OLD.source, OLD.external_id, OLD.field_group)
    OR NEW.security_revision < OLD.security_revision
    OR (NEW.taken_down IS DISTINCT FROM OLD.taken_down AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Source fence identity is immutable and changes require an increasing security revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_fence_identity BEFORE UPDATE OR DELETE ON content.source_fences
FOR EACH ROW EXECUTE FUNCTION content.guard_source_fence();

-- migrate:down
-- Forward only: retain tuple homes and security revisions.
