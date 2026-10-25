-- migrate:up
ALTER TABLE semantic.subject
  ADD COLUMN visibility text NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden', 'taken_down')),
  ADD COLUMN security_revision bigint NOT NULL DEFAULT 0 CHECK (security_revision >= 0);

CREATE FUNCTION semantic.guard_subject_security() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.visibility IS DISTINCT FROM OLD.visibility AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Visibility changes require an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subject_security_revision
BEFORE UPDATE ON semantic.subject
FOR EACH ROW EXECUTE FUNCTION semantic.guard_subject_security();

CREATE TABLE semantic.moderation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  action text NOT NULL CHECK (action IN ('hide', 'take_down', 'restore')),
  visibility text NOT NULL CHECK (visibility IN ('visible', 'hidden', 'taken_down')),
  actor uuid NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, security_revision),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

CREATE FUNCTION semantic.prevent_moderation_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'Semantic moderation records are immutable' USING ERRCODE = '23514'; END; $$;

CREATE TRIGGER moderation_immutable
BEFORE UPDATE OR DELETE ON semantic.moderation
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_moderation_mutation();

CREATE TRIGGER moderation_immutable_truncate
BEFORE TRUNCATE ON semantic.moderation
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_moderation_mutation();

-- migrate:down
DROP TABLE semantic.moderation;
DROP FUNCTION semantic.prevent_moderation_mutation();
DROP TRIGGER subject_security_revision ON semantic.subject;
DROP FUNCTION semantic.guard_subject_security();
ALTER TABLE semantic.subject DROP COLUMN security_revision, DROP COLUMN visibility;
