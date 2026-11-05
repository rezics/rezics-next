-- migrate:up
-- Current selection identities and original payloads, never disclosure verdicts.
CREATE TABLE semantic.search_selection_state (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  phase text NOT NULL DEFAULT 'facts' CHECK (phase IN ('facts', 'adoptions', 'done')),
  after_slot uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  after_seq integer NOT NULL DEFAULT 0,
  PRIMARY KEY (route, subject_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id)
);
CREATE TABLE semantic.search_selection_slot (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  expanded boolean NOT NULL DEFAULT false,
  head integer NOT NULL DEFAULT 0,
  PRIMARY KEY (route, subject_id, slot_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id)
);
CREATE TABLE semantic.search_selected (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  property text COLLATE "C" NOT NULL,
  rank text NOT NULL CHECK (rank IN ('normal', 'preferred')),
  ordinal integer NOT NULL,
  body jsonb NOT NULL,
  release text NOT NULL,
  revision integer NOT NULL,
  source jsonb,
  relation boolean NOT NULL,
  compact boolean NOT NULL,
  active boolean NOT NULL,
  log_seq integer NOT NULL,
  PRIMARY KEY (route, subject_id, slot_id, candidate_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision (route, subject_id, revision)
);
CREATE INDEX search_selected_page ON semantic.search_selected
  (route, subject_id, property, slot_id, candidate_id) WHERE active;
CREATE INDEX search_selected_value ON semantic.search_selected
  (route, subject_id, property, ((body->'value'->>'content') COLLATE "C"), slot_id, candidate_id) WHERE active;
-- Existing descriptive extraction must not walk relation degree or relation history.
CREATE INDEX search_fact_terms ON semantic.fact (route, subject_id, slot_id, log_seq)
  WHERE kind <> 'statement';
CREATE INDEX search_fact_descriptive ON semantic.fact (route, subject_id, slot_id, log_seq)
  WHERE kind = 'statement' AND NOT relation;
CREATE TABLE semantic.search_selection_retraction (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  log_seq integer NOT NULL,
  PRIMARY KEY (route, subject_id, slot_id, candidate_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id)
);

CREATE FUNCTION semantic.search_project_fact(f semantic.fact) RETURNS void LANGUAGE plpgsql AS $$
DECLARE expanded_slot boolean; r semantic.revision%ROWTYPE;
BEGIN
  IF f.kind <> 'statement' THEN RETURN; END IF;
  INSERT INTO semantic.search_selection_slot (route, subject_id, slot_id)
    VALUES (f.route, f.subject_id, f.slot_id) ON CONFLICT DO NOTHING;
  IF f.operation = 'expand' THEN
    UPDATE semantic.search_selection_slot SET expanded = true
      WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id;
    DELETE FROM semantic.search_selected WHERE route = f.route AND subject_id = f.subject_id
      AND slot_id = f.slot_id AND compact;
    RETURN;
  END IF;
  SELECT expanded INTO expanded_slot FROM semantic.search_selection_slot
    WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id;
  IF expanded_slot THEN RETURN; END IF;
  IF f.operation = 'retract' THEN
    INSERT INTO semantic.search_selection_retraction VALUES (f.route, f.subject_id, f.slot_id, f.statement_id, f.log_seq)
      ON CONFLICT (route, subject_id, slot_id, candidate_id) DO UPDATE
        SET log_seq = greatest(semantic.search_selection_retraction.log_seq, EXCLUDED.log_seq);
    UPDATE semantic.search_selected SET active = false, log_seq = f.log_seq
      WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id
        AND candidate_id = f.statement_id AND log_seq < f.log_seq;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM semantic.search_selection_retraction WHERE route = f.route AND subject_id = f.subject_id
    AND slot_id = f.slot_id AND candidate_id = f.statement_id AND log_seq >= f.log_seq) THEN RETURN; END IF;
  SELECT * INTO STRICT r FROM semantic.revision WHERE route = f.route AND subject_id = f.subject_id
    AND recorded_transaction_id = f.recorded_transaction_id;
  INSERT INTO semantic.search_selected
    (route, subject_id, slot_id, candidate_id, property, rank, ordinal, body, release, revision, source,
      relation, compact, active, log_seq)
    VALUES (f.route, f.subject_id, f.slot_id, f.statement_id, f.property, f.body->>'rank', f.log_seq,
      f.body, f.release, r.revision, r.source, f.relation, true, true, f.log_seq)
    ON CONFLICT (route, subject_id, slot_id, candidate_id) DO UPDATE
      SET active = true, log_seq = EXCLUDED.log_seq, body = EXCLUDED.body, rank = EXCLUDED.rank,
          ordinal = EXCLUDED.ordinal, release = EXCLUDED.release, revision = EXCLUDED.revision, source = EXCLUDED.source
      WHERE semantic.search_selected.log_seq < EXCLUDED.log_seq;
END;
$$;
CREATE FUNCTION semantic.search_project_adoption(a semantic.adoption) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF a.context_id <> '00000000-0000-8000-8000-000000000000'::uuid THEN RETURN; END IF;
  INSERT INTO semantic.search_selection_slot (route, subject_id, slot_id, expanded, head)
    VALUES (a.route, a.subject_id, a.slot_id, true, a.head)
    ON CONFLICT (route, subject_id, slot_id) DO UPDATE SET expanded = true, head = EXCLUDED.head
      WHERE semantic.search_selection_slot.head < EXCLUDED.head;
  IF NOT FOUND THEN RETURN; END IF;
  DELETE FROM semantic.search_selected WHERE route = a.route AND subject_id = a.subject_id AND slot_id = a.slot_id;
  IF a.mode <> 'replace' THEN RETURN; END IF;
  INSERT INTO semantic.search_selected
    (route, subject_id, slot_id, candidate_id, property, rank, ordinal, body, release, revision, source,
      relation, compact, active, log_seq)
    SELECT a.route, a.subject_id, a.slot_id, c.candidate_id, c.property, e.body->>'rank', e.ordinal,
      c.statement, c.release, c.revision, r.source, c.relation, false, true, 0
    FROM jsonb_array_elements(a.selection) WITH ORDINALITY AS e(body, ordinal)
    JOIN semantic.candidate c ON c.route = a.route AND c.subject_id = a.subject_id AND c.slot_id = a.slot_id
      AND c.candidate_id = (e.body->>'candidate')::uuid
    JOIN semantic.revision r ON r.route = a.route AND r.subject_id = a.subject_id AND r.revision = c.revision;
END;
$$;
CREATE FUNCTION semantic.search_project_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f semantic.fact%ROWTYPE; a semantic.adoption%ROWTYPE;
BEGIN
  INSERT INTO semantic.search_selection_state (route, subject_id)
    VALUES (NEW.route, NEW.subject_id) ON CONFLICT DO NOTHING;
  -- Serialize cold folding against only this source's native maintenance, never other homes.
  PERFORM 1 FROM semantic.search_selection_state WHERE route = NEW.route AND subject_id = NEW.subject_id FOR UPDATE;
  IF TG_ARGV[0] = 'fact' THEN f := NEW; PERFORM semantic.search_project_fact(f);
  ELSE a := NEW; PERFORM semantic.search_project_adoption(a); END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION semantic.search_project_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO semantic.search_selection_state (route, subject_id, ready, phase)
    VALUES (NEW.route, NEW.subject_id, true, 'done');
  RETURN NEW;
END;
$$;
CREATE TRIGGER search_project_subject AFTER INSERT ON semantic.subject
  FOR EACH ROW EXECUTE FUNCTION semantic.search_project_subject();
CREATE TRIGGER search_project_fact AFTER INSERT ON semantic.fact
  FOR EACH ROW WHEN (NEW.kind = 'statement') EXECUTE FUNCTION semantic.search_project_insert('fact');
CREATE TRIGGER search_project_adoption AFTER INSERT ON semantic.adoption
  FOR EACH ROW WHEN (NEW.context_id = '00000000-0000-8000-8000-000000000000'::uuid)
  EXECUTE FUNCTION semantic.search_project_insert('adoption');

CREATE INDEX search_fact_rebuild ON semantic.fact (route, subject_id, slot_id, log_seq)
  WHERE kind = 'statement';
CREATE INDEX search_adoption_rebuild ON semantic.adoption (route, subject_id, slot_id, head)
  WHERE context_id = '00000000-0000-8000-8000-000000000000'::uuid;
-- One cold key per transaction. The native selection array is bounded to 32, including rejects.
-- Current native writes use the same source-local state lock and supersede older folded heads.
CREATE FUNCTION semantic.search_rebuild_one(r integer, s uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE state semantic.search_selection_state%ROWTYPE; f semantic.fact%ROWTYPE; a semantic.adoption%ROWTYPE;
BEGIN
  INSERT INTO semantic.search_selection_state (route, subject_id)
    SELECT r, s FROM semantic.subject WHERE route = r AND subject_id = s ON CONFLICT DO NOTHING;
  SELECT * INTO state FROM semantic.search_selection_state WHERE route = r AND subject_id = s FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF state.ready THEN RETURN true; END IF;
  IF state.phase = 'facts' THEN
    SELECT * INTO f FROM semantic.fact WHERE route = r AND subject_id = s AND kind = 'statement'
      AND (slot_id, log_seq) > (state.after_slot, state.after_seq) ORDER BY slot_id, log_seq LIMIT 1;
    IF FOUND THEN
      PERFORM semantic.search_project_fact(f);
      UPDATE semantic.search_selection_state SET after_slot = f.slot_id, after_seq = f.log_seq WHERE route = r AND subject_id = s;
      RETURN false;
    END IF;
    UPDATE semantic.search_selection_state SET phase = 'adoptions', after_slot = '00000000-0000-0000-0000-000000000000',
      after_seq = 0 WHERE route = r AND subject_id = s;
    RETURN false;
  END IF;
  SELECT * INTO a FROM semantic.adoption WHERE route = r AND subject_id = s
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND (slot_id, head) > (state.after_slot, state.after_seq) ORDER BY slot_id, head LIMIT 1;
  IF FOUND THEN
    PERFORM semantic.search_project_adoption(a);
    UPDATE semantic.search_selection_state SET after_slot = a.slot_id, after_seq = a.head WHERE route = r AND subject_id = s;
    RETURN false;
  END IF;
  UPDATE semantic.search_selection_state SET ready = true, phase = 'done' WHERE route = r AND subject_id = s;
  RETURN true;
END;
$$;

-- Only consumed raw keys are retained. These rows are not permission or absence caches.
CREATE TABLE semantic.search_relation_probe (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  property text COLLATE "C" NOT NULL,
  value text COLLATE "C" NOT NULL,
  revision integer NOT NULL,
  after_slot uuid NOT NULL,
  after_candidate uuid NOT NULL,
  PRIMARY KEY (route, subject_id, property, value),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id)
);

-- migrate:down
DROP TABLE semantic.search_relation_probe;
DROP FUNCTION semantic.search_rebuild_one(integer, uuid);
DROP INDEX semantic.search_adoption_rebuild;
DROP INDEX semantic.search_fact_rebuild;
DROP TRIGGER search_project_adoption ON semantic.adoption;
DROP TRIGGER search_project_fact ON semantic.fact;
DROP TRIGGER search_project_subject ON semantic.subject;
DROP FUNCTION semantic.search_project_subject();
DROP FUNCTION semantic.search_project_insert();
DROP FUNCTION semantic.search_project_adoption(semantic.adoption);
DROP FUNCTION semantic.search_project_fact(semantic.fact);
DROP TABLE semantic.search_selected;
DROP TABLE semantic.search_selection_retraction;
DROP INDEX semantic.search_fact_descriptive;
DROP INDEX semantic.search_fact_terms;
DROP TABLE semantic.search_selection_slot;
DROP TABLE semantic.search_selection_state;
