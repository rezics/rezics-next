-- Owner-local verification DFS. Seek candidates before checking retractions:
-- a page of retracted edges still consumes the edge work budget.
CREATE INDEX lineage_edge_seek ON verification.lineage_edge (observation_id, id);
CREATE INDEX lineage_dependency_seek ON verification.lineage_edge (observation_id, id)
  WHERE relation <> 'publishes-origin';
CREATE INDEX lineage_publication_seek ON verification.lineage_edge (observation_id, id)
  WHERE relation = 'publishes-origin';

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

-- Lock the immutable observation as the serialization point even when its
-- lineage/disposition head was absent when the walk first visited it.
CREATE FUNCTION verification.stale_lineage_walk(changed_observation uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE affected uuid;
BEGIN
  PERFORM 1 FROM source.observation WHERE id = changed_observation FOR UPDATE;
  FOR affected IN UPDATE verification.lineage_walk_observation SET stale = true
    WHERE observation_id = changed_observation AND NOT stale RETURNING walk_id
  LOOP
    PERFORM verification.record_invalidation('lineage-walk', affected::text, NULL,
      'lineage-walk-stale:' || affected);
  END LOOP;
END $$;
CREATE FUNCTION verification.lineage_walk_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM verification.stale_lineage_walk(NEW.observation_id);
  RETURN NULL;
END $$;
CREATE TRIGGER lineage_walk_lineage_stale AFTER INSERT OR UPDATE ON verification.lineage_head
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_walk_head_changed();
CREATE TRIGGER lineage_walk_disposition_stale AFTER INSERT OR UPDATE ON verification.observation_disposition_head
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_walk_head_changed();
