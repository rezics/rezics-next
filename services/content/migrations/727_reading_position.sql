CREATE SCHEMA IF NOT EXISTS reading_position;

CREATE TABLE reading_position.revelation (
  record text NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('entity', 'name', 'alias', 'statement', 'relation')),
  continuity_work text NOT NULL,
  occurrence text NOT NULL,
  receipt text NOT NULL,
  PRIMARY KEY (record, continuity_work),
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
