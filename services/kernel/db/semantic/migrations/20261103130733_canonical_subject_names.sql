-- migrate:up
-- Extend the native Subject row; this is not a second Subject catalogue.
LOCK TABLE semantic.subject, semantic.term_head, semantic.fact IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE semantic.subject ADD COLUMN canonical_name text COLLATE "C";
ALTER TABLE semantic.partition_subjects
  ADD COLUMN canonical_count bigint NOT NULL DEFAULT 0 CHECK (canonical_count >= 0),
  ADD COLUMN canonical_generation bigint NOT NULL DEFAULT 1 CHECK (canonical_generation > 0);

-- Match SubjectSource's language ordering and last value in slot/log order exactly.
CREATE FUNCTION semantic.refresh_canonical_subject_name(r integer, id uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE semantic.subject SET canonical_name=(
    SELECT f.body #>> '{}' FROM semantic.current_term_fact f
    WHERE f.route=r AND f.subject_id=id AND f.kind='label' AND jsonb_typeof(f.body)='string'
    ORDER BY f.language COLLATE "C",f.slot_id DESC,f.log_seq DESC LIMIT 1
  ) WHERE route=r AND subject_id=id;
$$;

CREATE FUNCTION semantic.capture_canonical_subject_name() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE FUNCTION semantic.capture_canonical_subject_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE semantic.partition_subjects
      SET canonical_count=canonical_count-1,canonical_generation=canonical_generation+1
      WHERE partition_no=OLD.route/16;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO semantic.partition_subjects(partition_no,canonical_count,canonical_generation)
      VALUES(NEW.route/16,1,1)
      ON CONFLICT(partition_no) DO UPDATE SET canonical_count=partition_subjects.canonical_count+1,
        canonical_generation=partition_subjects.canonical_generation+1;
  END IF;
  RETURN NULL;
END;
$$;

UPDATE semantic.subject s SET canonical_name=(
  SELECT f.body #>> '{}' FROM semantic.current_term_fact f
  WHERE f.route=s.route AND f.subject_id=s.subject_id AND f.kind='label' AND jsonb_typeof(f.body)='string'
  ORDER BY f.language COLLATE "C",f.slot_id DESC,f.log_seq DESC LIMIT 1
);
INSERT INTO semantic.partition_subjects(partition_no,canonical_count)
  SELECT route/16,count(*) FROM semantic.subject GROUP BY route/16
  ON CONFLICT(partition_no) DO UPDATE SET canonical_count=EXCLUDED.canonical_count;

CREATE TRIGGER subject_canonical_population AFTER INSERT OR UPDATE OR DELETE ON semantic.subject
FOR EACH ROW EXECUTE FUNCTION semantic.capture_canonical_subject_population();
CREATE INDEX subject_canonical_name_seek ON semantic.subject
  ((route/16),(canonical_name IS NULL),(COALESCE(canonical_name,'') COLLATE "C"),subject_id);
CREATE INDEX partition_subjects_canonical_frontier ON semantic.partition_subjects(partition_no)
  INCLUDE(canonical_generation) WHERE canonical_count>0;

-- migrate:down
DROP INDEX semantic.partition_subjects_canonical_frontier;
DROP INDEX semantic.subject_canonical_name_seek;
DROP TRIGGER subject_canonical_population ON semantic.subject;
DROP FUNCTION semantic.capture_canonical_subject_population();
DROP TRIGGER fact_canonical_name ON semantic.fact;
DROP TRIGGER term_head_canonical_name ON semantic.term_head;
DROP FUNCTION semantic.capture_canonical_subject_name();
DROP FUNCTION semantic.refresh_canonical_subject_name(integer,uuid);
ALTER TABLE semantic.partition_subjects DROP COLUMN canonical_count,DROP COLUMN canonical_generation;
ALTER TABLE semantic.subject DROP COLUMN canonical_name;
