-- Local owner events for verification freshness. Every Content-owned change a
-- summary can depend on advances an exact head and records its invalidation work
-- in the same transaction; graph-owned changes are recorded by Main from the
-- graph receipt/event identity. Reads never trust this queue for freshness.

-- Per-observation lineage head: bumped when an edge, retraction or derivation
-- about that observation commits, so a summary pins every visited lineage node.
CREATE TABLE verification.lineage_head (
  observation_id uuid PRIMARY KEY REFERENCES source.observation(id),
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION verification.record_invalidation(change_kind text, change_reference text,
  change_head text, change_event text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO verification.invalidation (id, producer, event_key, kind, reference, changed_head)
  VALUES (gen_random_uuid(), 'content', change_event, change_kind, change_reference, change_head)
  ON CONFLICT (producer, event_key) DO NOTHING;
$$;

CREATE FUNCTION verification.bump_lineage(observation uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE next_revision bigint;
BEGIN
  INSERT INTO verification.lineage_head (observation_id, revision) VALUES (observation, 1)
  ON CONFLICT (observation_id) DO UPDATE SET revision = lineage_head.revision + 1,
    updated_at = clock_timestamp()
  RETURNING revision INTO next_revision;
  PERFORM verification.record_invalidation('source-observation', observation::text,
    next_revision::text, 'lineage:' || observation || ':' || next_revision);
END $$;

CREATE FUNCTION verification.lineage_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation uuid;
BEGIN
  IF TG_TABLE_NAME = 'lineage_edge' THEN observation := NEW.observation_id;
  ELSIF TG_TABLE_NAME = 'derivation' THEN observation := NEW.output_observation_id;
  ELSE SELECT e.observation_id INTO observation FROM verification.lineage_edge e WHERE e.id = NEW.edge_id;
  END IF;
  IF observation IS NOT NULL THEN PERFORM verification.bump_lineage(observation); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER lineage_edge_head AFTER INSERT ON verification.lineage_edge
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_changed();
CREATE TRIGGER lineage_retraction_head AFTER INSERT ON verification.lineage_retraction
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_changed();
CREATE TRIGGER derivation_head AFTER INSERT ON verification.derivation
  FOR EACH ROW EXECUTE FUNCTION verification.lineage_changed();

CREATE FUNCTION verification.evidence_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM verification.record_invalidation('evidence-set', NEW.claim, NEW.head::text,
    'evidence:' || NEW.head);
  RETURN NULL;
END $$;
CREATE TRIGGER evidence_head_invalidation AFTER INSERT OR UPDATE ON verification.evidence_head
  FOR EACH ROW EXECUTE FUNCTION verification.evidence_head_changed();

CREATE FUNCTION verification.challenge_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM verification.record_invalidation('challenge', NEW.claim, NEW.revision::text,
    'challenge:' || NEW.claim || ':' || NEW.revision);
  RETURN NULL;
END $$;
CREATE TRIGGER challenge_head_invalidation AFTER INSERT OR UPDATE ON verification.challenge_head
  FOR EACH ROW EXECUTE FUNCTION verification.challenge_head_changed();

-- A material correction: activation changed the support or dispute dimension.
-- It is written by the activation itself and has no deletion path, so no
-- challenger, funder or later withdrawal can suppress it.
CREATE TABLE verification.correction_notice (
  generation_id uuid PRIMARY KEY REFERENCES verification.summary_generation(id),
  target verification.iri NOT NULL,
  context verification.iri NOT NULL,
  previous_generation uuid NOT NULL REFERENCES verification.summary_generation(id),
  previous_support text NOT NULL,
  support text NOT NULL,
  previous_dispute text NOT NULL,
  dispute text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((previous_support, previous_dispute) IS DISTINCT FROM (support, dispute))
);
CREATE INDEX correction_notice_summary ON verification.correction_notice (target, context, created_at, generation_id);
CREATE INDEX correction_notice_previous ON verification.correction_notice (previous_generation);
CREATE TRIGGER verification_correction_notice_immutable BEFORE UPDATE OR DELETE
  ON verification.correction_notice FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

CREATE FUNCTION verification.record_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO verification.correction_notice (generation_id, target, context, previous_generation,
    previous_support, support, previous_dispute, dispute)
  SELECT n.id, NEW.target, NEW.context, o.id, o.support, n.support, o.dispute, n.dispute
  FROM verification.summary_generation n, verification.summary_generation o
  WHERE n.id = NEW.active_generation AND o.id = OLD.active_generation
    AND (o.support, o.dispute) IS DISTINCT FROM (n.support, n.dispute);
  RETURN NULL;
END $$;
CREATE TRIGGER summary_head_correction AFTER UPDATE OF active_generation ON verification.summary_head
  FOR EACH ROW EXECUTE FUNCTION verification.record_correction();

-- A worker completes demand only for the exact invalidation it observed.
CREATE INDEX invalidation_pending_lease ON verification.invalidation (lease_until) WHERE state = 'pending';
