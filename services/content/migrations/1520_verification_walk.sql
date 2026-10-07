-- Owner-local verification DFS. Seek candidates before checking retractions:
-- a page of retracted edges still consumes the edge work budget.
CREATE INDEX lineage_edge_seek ON verification.lineage_edge (observation_id, id);
CREATE INDEX lineage_dependency_seek ON verification.lineage_edge (observation_id, id)
  WHERE relation <> 'publishes-origin';
CREATE INDEX lineage_publication_seek ON verification.lineage_edge (observation_id, id)
  WHERE relation = 'publishes-origin';

-- The existing invalidation journal also provides a committed, local source
-- change position. Its one-row lock fixes event order without walk fan-out.
CREATE TABLE verification.lineage_change_head (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision bigint NOT NULL CHECK (revision >= 0)
);
INSERT INTO verification.lineage_change_head VALUES (true, 0);
ALTER TABLE verification.invalidation ADD COLUMN local_sequence bigint CHECK (local_sequence > 0);
ALTER TABLE verification.invalidation ADD COLUMN cursor_walk uuid;
ALTER TABLE verification.invalidation ADD COLUMN walks_complete boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX invalidation_local_sequence ON verification.invalidation (local_sequence)
  WHERE local_sequence IS NOT NULL;

CREATE TABLE verification.lineage_walk (
  id uuid PRIMARY KEY,
  claim verification.rezics_id NOT NULL,
  evidence_revision uuid NOT NULL REFERENCES verification.evidence_set_revision(id),
  authority_digest verification.sha256 NOT NULL,
  start_key text NOT NULL,
  root_ordinal integer NOT NULL DEFAULT 0 CHECK (root_ordinal BETWEEN 0 AND 32),
  complete boolean NOT NULL DEFAULT false,
  unknown boolean NOT NULL DEFAULT false,
  circular boolean NOT NULL DEFAULT false,
  origin_count bigint NOT NULL DEFAULT 0 CHECK (origin_count >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  expansions bigint NOT NULL DEFAULT 0 CHECK (expansions >= 0),
  edges bigint NOT NULL DEFAULT 0 CHECK (edges >= 0),
  node_count bigint NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  validated_sequence bigint NOT NULL DEFAULT 0 CHECK (validated_sequence >= 0),
  UNIQUE (claim, evidence_revision, authority_digest, start_key)
);
CREATE TABLE verification.lineage_walk_observation (
  walk_id uuid NOT NULL REFERENCES verification.lineage_walk(id),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  lineage_head text,
  disposition_head uuid,
  stale boolean NOT NULL DEFAULT false,
  PRIMARY KEY (walk_id, observation_id)
);
CREATE INDEX lineage_walk_observation_reverse ON verification.lineage_walk_observation (observation_id, walk_id);
CREATE INDEX lineage_walk_stale ON verification.lineage_walk_observation (walk_id) WHERE stale;
CREATE TABLE verification.lineage_walk_node (
  walk_id uuid NOT NULL REFERENCES verification.lineage_walk(id),
  root_ordinal integer NOT NULL CHECK (root_ordinal BETWEEN 0 AND 31),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  depth integer NOT NULL CHECK (depth >= 0),
  done boolean NOT NULL DEFAULT false,
  phase integer NOT NULL DEFAULT 0 CHECK (phase BETWEEN 0 AND 2),
  edge_cursor uuid,
  input_cursor integer NOT NULL DEFAULT -1 CHECK (input_cursor BETWEEN -1 AND 31),
  has_links boolean NOT NULL DEFAULT false,
  PRIMARY KEY (walk_id, root_ordinal, observation_id)
);
CREATE INDEX lineage_walk_frontier ON verification.lineage_walk_node (walk_id, root_ordinal, depth DESC) WHERE NOT done;
CREATE TABLE verification.lineage_walk_origin (
  walk_id uuid NOT NULL REFERENCES verification.lineage_walk(id),
  origin_id uuid NOT NULL REFERENCES verification.origin(id),
  PRIMARY KEY (walk_id, origin_id)
);
CREATE TABLE verification.lineage_walk_step (
  walk_id uuid NOT NULL REFERENCES verification.lineage_walk(id),
  version integer NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (walk_id, version)
);

ALTER TABLE verification.summary_dependency DROP CONSTRAINT summary_dependency_kind_check;
ALTER TABLE verification.summary_dependency ADD CONSTRAINT summary_dependency_kind_check CHECK (kind IN
  ('claim', 'evidence-set', 'source-assessment', 'source-observation', 'source-disposition',
   'challenge', 'policy', 'rule', 'acceptance', 'adopted-revision', 'lineage-walk'));
ALTER TABLE verification.invalidation DROP CONSTRAINT invalidation_kind_check;
ALTER TABLE verification.invalidation ADD CONSTRAINT invalidation_kind_check CHECK (kind IN
  ('claim', 'evidence-set', 'source-assessment', 'source-observation', 'source-disposition',
   'challenge', 'policy', 'rule', 'acceptance', 'adopted-revision', 'lineage-walk'));

-- A source edit publishes exactly one existing source invalidation. Dependent
-- walks are sought by the bounded drain, never touched by this trigger.
CREATE FUNCTION verification.lineage_walk_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_sequence bigint; change_kind text; change_head text; change_event text;
BEGIN
  IF TG_TABLE_NAME = 'lineage_head' THEN
    IF TG_OP = 'UPDATE' AND NEW.revision = OLD.revision THEN RETURN NULL; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.head = OLD.head THEN RETURN NULL; END IF;
  END IF;
  UPDATE verification.lineage_change_head SET revision = revision + 1 WHERE singleton
    RETURNING revision INTO next_sequence;
  -- Readers lock the change head before observations, keeping the same order.
  PERFORM 1 FROM source.observation WHERE id = NEW.observation_id FOR UPDATE;
  IF TG_TABLE_NAME = 'lineage_head' THEN
    change_kind := 'source-observation'; change_head := NEW.revision::text;
    change_event := 'lineage:' || NEW.observation_id || ':' || NEW.revision;
  ELSE
    change_kind := 'source-disposition'; change_head := NEW.head::text;
    change_event := 'source-disposition:' || NEW.head;
  END IF;
  PERFORM verification.record_invalidation(change_kind, NEW.observation_id::text, change_head, change_event);
  UPDATE verification.invalidation SET local_sequence = next_sequence
    WHERE producer = 'content' AND event_key = change_event;
  RETURN NULL;
END $$;
CREATE TRIGGER lineage_walk_lineage_stale AFTER INSERT OR UPDATE ON verification.lineage_head
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_walk_head_changed();
CREATE TRIGGER lineage_walk_disposition_stale AFTER INSERT OR UPDATE ON verification.observation_disposition_head
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_walk_head_changed();

CREATE FUNCTION verification.guard_walk_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.local_sequence IS NOT NULL AND NEW.local_sequence IS DISTINCT FROM OLD.local_sequence)
    OR (OLD.walks_complete AND NOT NEW.walks_complete)
    OR (OLD.cursor_walk IS NOT NULL AND (NEW.cursor_walk IS NULL OR NEW.cursor_walk < OLD.cursor_walk)) THEN
    RAISE EXCEPTION 'walk invalidation work may only advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invalidation_walk_monotone BEFORE UPDATE ON verification.invalidation
  FOR EACH ROW EXECUTE FUNCTION verification.guard_walk_invalidation();
