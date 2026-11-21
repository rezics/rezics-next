-- migrate:up
DROP TRIGGER fact_term_head ON semantic.fact;
DROP TRIGGER term_head_canonical_name ON semantic.term_head;
DROP TRIGGER fact_canonical_name ON semantic.fact;

-- One upsert per occurrence of a repeated head key. Independent keys share a write,
-- while aliases and competing slots retain their arrival order within each head.
CREATE OR REPLACE FUNCTION semantic.capture_term_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch semantic.fact[];
BEGIN
 FOR batch IN
   WITH arrivals AS (
     SELECT f::semantic.fact AS fact,row_number() OVER () AS position FROM inserted_facts f WHERE kind<>'statement'
   ), heads AS (
     SELECT fact,position,row_number() OVER (
       PARTITION BY (fact).route,(fact).subject_id,(fact).kind,(fact).language ORDER BY position
     ) AS occurrence FROM arrivals
   )
   SELECT array_agg(fact ORDER BY position) FROM heads GROUP BY occurrence ORDER BY occurrence
 LOOP
   INSERT INTO semantic.term_head(route,subject_id,kind,language,slot_id,first_seq,support_transaction_id)
   SELECT f.route,f.subject_id,f.kind,f.language,f.slot_id,CASE WHEN f.kind='alias' THEN 1 ELSE f.log_seq END,
     f.recorded_transaction_id FROM unnest(batch) f
   ON CONFLICT(route,subject_id,kind,language) DO UPDATE
   SET slot_id=EXCLUDED.slot_id,first_seq=EXCLUDED.first_seq,active=true
   WHERE term_head.slot_id=EXCLUDED.slot_id OR EXISTS (
     SELECT 1 FROM semantic.revision r WHERE r.route=EXCLUDED.route AND r.subject_id=EXCLUDED.subject_id
       AND r.recorded_transaction_id=EXCLUDED.support_transaction_id AND r.kind='identity');
 END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER fact_term_head AFTER INSERT ON semantic.fact REFERENCING NEW TABLE AS inserted_facts
FOR EACH STATEMENT EXECUTE FUNCTION semantic.capture_term_head();

CREATE OR REPLACE FUNCTION semantic.refresh_canonical_subject_name(r integer, id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Read the heads after any concurrent writer of this Subject finishes.
  PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=id FOR NO KEY UPDATE;
  UPDATE semantic.subject SET canonical_name=(
    SELECT f.body #>> '{}' FROM semantic.term_head h
    CROSS JOIN LATERAL (
      -- Each active head points at one slot with at most 33 log entries.
      SELECT fact.body,fact.language,fact.log_seq FROM semantic.fact
      WHERE fact.route=h.route AND fact.subject_id=h.subject_id AND fact.slot_id=h.slot_id
        AND fact.log_seq>=h.first_seq AND fact.operation='assert' AND fact.kind='label'
        AND jsonb_typeof(fact.body)='string'
      ORDER BY fact.language COLLATE "C",fact.log_seq DESC LIMIT 1
    ) f WHERE h.route=r AND h.subject_id=id AND h.active
    ORDER BY f.language COLLATE "C",h.slot_id DESC,f.log_seq DESC LIMIT 1
  ) WHERE route=r AND subject_id=id;
END;
$$;

CREATE FUNCTION semantic.capture_canonical_label_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner record;
BEGIN
  FOR owner IN SELECT route,subject_id,count(*) AS changes FROM changed_labels WHERE kind='label'
    GROUP BY route,subject_id ORDER BY route,subject_id
  LOOP
    PERFORM semantic.refresh_canonical_subject_name(owner.route,owner.subject_id);
    -- Each original label mutation signals Subject writers. Preserve their exact
    -- generations without joining and sorting the same final heads a second time.
    FOR i IN 2..owner.changes LOOP
      UPDATE semantic.subject SET canonical_name=canonical_name WHERE route=owner.route AND subject_id=owner.subject_id;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

-- The UPDATE transition contains the new owners. Handle an old owner that
-- moved, and the new owner of a row that left the label kind.
CREATE OR REPLACE FUNCTION semantic.capture_canonical_subject_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.route,OLD.subject_id) IS DISTINCT FROM (NEW.route,NEW.subject_id) THEN
    PERFORM semantic.refresh_canonical_subject_name(OLD.route,OLD.subject_id);
  END IF;
  IF NEW.kind<>'label' THEN
    PERFORM semantic.refresh_canonical_subject_name(NEW.route,NEW.subject_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER term_head_canonical_name_insert AFTER INSERT ON semantic.term_head REFERENCING NEW TABLE AS changed_labels
FOR EACH STATEMENT EXECUTE FUNCTION semantic.capture_canonical_label_batch();
CREATE TRIGGER term_head_canonical_name_update AFTER UPDATE ON semantic.term_head REFERENCING NEW TABLE AS changed_labels
FOR EACH STATEMENT EXECUTE FUNCTION semantic.capture_canonical_label_batch();
CREATE TRIGGER term_head_canonical_name_delete AFTER DELETE ON semantic.term_head REFERENCING OLD TABLE AS changed_labels
FOR EACH STATEMENT EXECUTE FUNCTION semantic.capture_canonical_label_batch();
CREATE TRIGGER term_head_canonical_name_move AFTER UPDATE ON semantic.term_head FOR EACH ROW
WHEN ((OLD.kind='label' OR NEW.kind='label') AND
  (NEW.kind<>'label' OR (OLD.route,OLD.subject_id) IS DISTINCT FROM (NEW.route,NEW.subject_id)))
EXECUTE FUNCTION semantic.capture_canonical_subject_name();
CREATE TRIGGER fact_canonical_name_update AFTER UPDATE ON semantic.fact REFERENCING NEW TABLE AS changed_labels
FOR EACH STATEMENT EXECUTE FUNCTION semantic.capture_canonical_label_batch();
CREATE TRIGGER fact_canonical_name_delete AFTER DELETE ON semantic.fact REFERENCING OLD TABLE AS changed_labels
FOR EACH STATEMENT EXECUTE FUNCTION semantic.capture_canonical_label_batch();
-- migrate:down
DROP TRIGGER term_head_canonical_name_insert ON semantic.term_head;
DROP TRIGGER term_head_canonical_name_update ON semantic.term_head;
DROP TRIGGER term_head_canonical_name_delete ON semantic.term_head;
DROP TRIGGER term_head_canonical_name_move ON semantic.term_head;
DROP TRIGGER fact_canonical_name_update ON semantic.fact;
DROP TRIGGER fact_canonical_name_delete ON semantic.fact;
DROP FUNCTION semantic.capture_canonical_label_batch();
DROP TRIGGER fact_term_head ON semantic.fact;
CREATE OR REPLACE FUNCTION semantic.capture_term_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='statement' THEN RETURN NEW; END IF;
 INSERT INTO semantic.term_head(route,subject_id,kind,language,slot_id,first_seq,support_transaction_id)
 VALUES(NEW.route,NEW.subject_id,NEW.kind,NEW.language,NEW.slot_id,
   CASE WHEN NEW.kind='alias' THEN 1 ELSE NEW.log_seq END,NEW.recorded_transaction_id)
 ON CONFLICT(route,subject_id,kind,language) DO UPDATE
 SET slot_id=EXCLUDED.slot_id,first_seq=EXCLUDED.first_seq,active=true
 WHERE term_head.slot_id=EXCLUDED.slot_id OR EXISTS (
   SELECT 1 FROM semantic.revision r WHERE r.route=NEW.route AND r.subject_id=NEW.subject_id
     AND r.recorded_transaction_id=NEW.recorded_transaction_id AND r.kind='identity');
 RETURN NEW;
END; $$;
CREATE TRIGGER fact_term_head AFTER INSERT ON semantic.fact
FOR EACH ROW EXECUTE FUNCTION semantic.capture_term_head();

CREATE OR REPLACE FUNCTION semantic.refresh_canonical_subject_name(r integer, id uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE semantic.subject SET canonical_name=(
    SELECT f.body #>> '{}' FROM semantic.current_term_fact f
    WHERE f.route=r AND f.subject_id=id AND f.kind='label' AND jsonb_typeof(f.body)='string'
    ORDER BY f.language COLLATE "C",f.slot_id DESC,f.log_seq DESC LIMIT 1
  ) WHERE route=r AND subject_id=id;
$$;

CREATE OR REPLACE FUNCTION semantic.capture_canonical_subject_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind='label' THEN
      PERFORM semantic.refresh_canonical_subject_name(OLD.route,OLD.subject_id);
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.kind='label' THEN
      PERFORM semantic.refresh_canonical_subject_name(NEW.route,NEW.subject_id);
    END IF;
  ELSIF OLD.kind='label' OR NEW.kind='label' THEN
    IF (OLD.route,OLD.subject_id) IS DISTINCT FROM (NEW.route,NEW.subject_id) THEN
      PERFORM semantic.refresh_canonical_subject_name(OLD.route,OLD.subject_id);
    END IF;
    PERFORM semantic.refresh_canonical_subject_name(NEW.route,NEW.subject_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER term_head_canonical_name AFTER INSERT OR UPDATE OR DELETE ON semantic.term_head
FOR EACH ROW EXECUTE FUNCTION semantic.capture_canonical_subject_name();
-- Erasure may physically remove or minimize the immutable fact through its existing privileged writer.
CREATE TRIGGER fact_canonical_name AFTER UPDATE OR DELETE ON semantic.fact
FOR EACH ROW EXECUTE FUNCTION semantic.capture_canonical_subject_name();
