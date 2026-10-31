-- migrate:up
-- Compact facts preserve deprecated statements, but they are not selected public values.
-- Keep the authoritative write valid without admitting a deprecated row to this projection.
CREATE OR REPLACE FUNCTION semantic.search_project_fact(f semantic.fact) RETURNS void LANGUAGE plpgsql AS $$
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
  IF f.body->>'rank' NOT IN ('normal', 'preferred') THEN
    UPDATE semantic.search_selected SET active = false, log_seq = f.log_seq
      WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id
        AND candidate_id = f.statement_id AND log_seq < f.log_seq;
    RETURN;
  END IF;
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

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.search_project_fact(f semantic.fact) RETURNS void LANGUAGE plpgsql AS $$
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