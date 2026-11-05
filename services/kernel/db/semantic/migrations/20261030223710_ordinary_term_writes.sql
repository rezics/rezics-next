-- migrate:up
ALTER TABLE semantic.revision DROP CONSTRAINT revision_kind_check;
ALTER TABLE semantic.revision ADD CONSTRAINT revision_kind_check CHECK
  (kind IN ('create','propose','accept','reject','adopt','merge','retract','identity','terms'));
ALTER TABLE semantic.revision ADD COLUMN term_changes jsonb;
ALTER TABLE semantic.revision ADD COLUMN term_support integer[];
ALTER TABLE semantic.revision ADD CONSTRAINT revision_terms_check CHECK
  ((kind = 'terms') = (term_changes IS NOT NULL AND term_support IS NOT NULL));

-- Only technical pointers live here. Personal text remains in the existing immutable
-- fact producer, with its original erasure locators and minimizers.
CREATE TABLE semantic.term_head (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('label','description','alias')),
  language text NOT NULL,
  slot_id uuid NOT NULL,
  first_seq integer NOT NULL CHECK (first_seq >= 1),
  support_transaction_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (route,subject_id,kind,language),
  FOREIGN KEY (route,subject_id) REFERENCES semantic.subject(route,subject_id)
);
CREATE INDEX term_head_active ON semantic.term_head(route,subject_id,kind,language) WHERE active;
INSERT INTO semantic.term_head(route,subject_id,kind,language,slot_id,first_seq,support_transaction_id)
SELECT DISTINCT ON (route,subject_id,kind,language)
  route,subject_id,kind,language,slot_id,
  CASE WHEN kind='alias' THEN 1 ELSE log_seq END,recorded_transaction_id
FROM semantic.fact WHERE kind <> 'statement'
ORDER BY route,subject_id,kind,language,log_seq DESC;

-- Existing creation, derived Account labels and identity writes keep using their
-- native fact writer. Ordinary replacements explicitly switch the pointer later.
CREATE FUNCTION semantic.capture_term_head() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE VIEW semantic.current_term_fact AS
SELECT f.route,f.subject_id,f.slot_id,f.log_seq,f.operation,f.kind,f.language,
       f.property,f.statement_id,f.body,h.support_transaction_id AS recorded_transaction_id,
       f.release,f.relation,f.erasure_key
FROM semantic.term_head h
JOIN semantic.fact f ON f.route=h.route AND f.subject_id=h.subject_id AND f.slot_id=h.slot_id
  AND f.log_seq>=h.first_seq
WHERE h.active AND f.operation='assert';

-- migrate:down
DROP VIEW semantic.current_term_fact;
DROP TRIGGER fact_term_head ON semantic.fact;
DROP FUNCTION semantic.capture_term_head();
DROP TABLE semantic.term_head;
ALTER TABLE semantic.revision DROP CONSTRAINT revision_terms_check;
ALTER TABLE semantic.revision DROP COLUMN term_support;
ALTER TABLE semantic.revision DROP COLUMN term_changes;
ALTER TABLE semantic.revision DROP CONSTRAINT revision_kind_check;
ALTER TABLE semantic.revision ADD CONSTRAINT revision_kind_check CHECK
  (kind IN ('create','propose','accept','reject','adopt','merge','retract','identity'));
