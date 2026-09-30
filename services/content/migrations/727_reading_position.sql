CREATE SCHEMA IF NOT EXISTS reading_position;

CREATE TABLE reading_position.revelation (
  record text PRIMARY KEY,
  record_kind text NOT NULL CHECK (record_kind IN ('entity', 'name', 'alias', 'statement', 'relation')),
  continuity_work text NOT NULL,
  occurrence text NOT NULL,
  receipt text NOT NULL,
  CHECK (record <> '' AND continuity_work <> '' AND occurrence <> '' AND receipt <> '')
);
CREATE INDEX revelation_continuity ON reading_position.revelation (continuity_work, record);

-- A correction must expire continuations even when it changes only Content.
CREATE TABLE reading_position.generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO reading_position.generation (singleton) VALUES (true);
CREATE FUNCTION reading_position.advance_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE reading_position.generation SET version = version + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
CREATE TRIGGER revelation_generation AFTER INSERT OR UPDATE OR DELETE ON reading_position.revelation
  FOR EACH STATEMENT EXECUTE FUNCTION reading_position.advance_generation();

-- Private progress moves independently of the graph. Indexed owner generations
-- bind continuations without rescanning the reader's entire history.
CREATE TABLE reading_position.principal_generation (
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (principal_issuer, principal_subject)
);
CREATE TABLE reading_position.agent_generation (
  agent text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1
);
CREATE FUNCTION reading_position.advance_principal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO reading_position.principal_generation (principal_issuer, principal_subject)
    VALUES (r.principal_issuer, r.principal_subject)
    ON CONFLICT (principal_issuer, principal_subject) DO UPDATE
      SET version = reading_position.principal_generation.version + 1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER reading_progress_generation AFTER INSERT OR UPDATE OR DELETE ON structure.progress
  FOR EACH ROW EXECUTE FUNCTION reading_position.advance_principal();
CREATE TRIGGER reading_session_generation AFTER INSERT OR UPDATE OR DELETE ON reader.consumption_session
  FOR EACH ROW EXECUTE FUNCTION reading_position.advance_principal();
CREATE FUNCTION reading_position.advance_agent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO reading_position.agent_generation (agent) VALUES (r.agent)
    ON CONFLICT (agent) DO UPDATE SET version = reading_position.agent_generation.version + 1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER reading_library_generation AFTER INSERT OR UPDATE OR DELETE ON reader.library_status
  FOR EACH ROW EXECUTE FUNCTION reading_position.advance_agent();
