-- migrate:up
-- The Source cursor advances only after the ordinary generation writer and
-- physical comparison have accepted the original step. It is independent of
-- the receiver's coverage and ACK cursors.
CREATE TABLE semantic.subject_source_preparation_v1 (
  birth bigint PRIMARY KEY REFERENCES core.subject_subscription_v1,
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  bootstrap uuid NOT NULL,
  FOREIGN KEY (partition_no,bootstrap) REFERENCES semantic.public_filter_bootstrap,
  next_home integer NOT NULL DEFAULT 0 CHECK (next_home BETWEEN 0 AND 4096),
  next_ordinal integer NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0)
);
-- Resolve an earlier prepared request even after it left the capturing index.
CREATE INDEX subject_prepared_original ON semantic.public_filter_bootstrap(partition_no,request_key)
  WHERE snapshot_kind='prepared';
CREATE TABLE semantic.subject_source_step_v1 (
  birth bigint NOT NULL,
  first_home integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal>=0),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536),
  PRIMARY KEY (birth,first_home,ordinal),
  FOREIGN KEY (birth,first_home) REFERENCES semantic.subject_access_page_v1(birth,first_home)
);
-- Source stores its consumer using the tagged encoding from its binding
-- port. Only objects and scalar values occur in a held Subject consumer.
CREATE FUNCTION semantic.subject_source_consumer_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE jsonb_typeof(value) WHEN 'object' THEN
    jsonb_build_array('object',(SELECT coalesce(jsonb_agg(jsonb_build_array(k,
      semantic.subject_source_consumer_v1(v)) ORDER BY k COLLATE "C"),'[]'::jsonb) FROM jsonb_each(value) e(k,v)))
    ELSE jsonb_build_array('value',value) END
$$;

CREATE FUNCTION semantic.guard_subject_source_cursor_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved jsonb; page_end integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF (NEW.next_home,NEW.next_ordinal) IS DISTINCT FROM (0,0) OR NOT EXISTS (
      SELECT FROM core.subject_subscription_v1 m
      JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.read_definition)=
        (0,m.bootstrap,m.definition) AND b.snapshot_kind='prepared' AND b.state='capturing'
      JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition,d.source_id,d.configuration,
        d.release_digest)=(b.partition_no,b.read_definition,m.source_id,m.configuration,m.meaning)
      JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration,s.owner_epoch)=
        (d.partition_no,d.source_id,d.configuration,b.owner_epoch)
      JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
      WHERE (m.birth,b.partition_no,b.bootstrap)=(NEW.birth,NEW.partition_no,NEW.bootstrap)
        AND b.consumer::jsonb=semantic.subject_source_consumer_v1(m.consumer))
      THEN RAISE EXCEPTION 'Missing original held Subject Source bootstrap' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;

  IF (NEW.birth,NEW.partition_no,NEW.bootstrap) IS DISTINCT FROM (OLD.birth,OLD.partition_no,OLD.bootstrap)
    THEN RAISE EXCEPTION 'Held Subject Source identity is immutable' USING ERRCODE='23514'; END IF;
  SELECT step.evidence,page.end_home INTO saved,page_end
    FROM semantic.subject_source_step_v1 step JOIN semantic.subject_access_page_v1 page USING(birth,first_home)
    WHERE (step.birth,step.first_home,step.ordinal)=(OLD.birth,OLD.next_home,OLD.next_ordinal);
  IF FOUND AND saved->'ordinal'=to_jsonb(OLD.next_ordinal) THEN
    IF saved->'complete'='true'::jsonb AND saved->'next'='null'::jsonb AND
      (NEW.next_home,NEW.next_ordinal)=(page_end,0) THEN RETURN NEW; END IF;
    IF saved->'complete'='false'::jsonb AND jsonb_typeof(saved->'next')='object' AND
      (NEW.next_home,NEW.next_ordinal::bigint)=(OLD.next_home,OLD.next_ordinal::bigint+1) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Missing exact held Subject Source successor' USING ERRCODE='23514';
END $$;
CREATE TRIGGER subject_source_cursor BEFORE INSERT OR UPDATE ON semantic.subject_source_preparation_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.guard_subject_source_cursor_v1();
CREATE TRIGGER subject_source_step_original BEFORE UPDATE OR DELETE ON semantic.subject_source_step_v1
  FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_source_step_truncate BEFORE TRUNCATE ON semantic.subject_source_step_v1
  FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_source_preparation_original BEFORE DELETE ON semantic.subject_source_preparation_v1
  FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_source_preparation_truncate BEFORE TRUNCATE ON semantic.subject_source_preparation_v1
  FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();

ALTER TABLE semantic.subject_source_preparation_v1 ENABLE ALWAYS TRIGGER subject_source_cursor;
ALTER TABLE semantic.subject_source_preparation_v1 ENABLE ALWAYS TRIGGER subject_source_preparation_original;
ALTER TABLE semantic.subject_source_preparation_v1 ENABLE ALWAYS TRIGGER subject_source_preparation_truncate;
ALTER TABLE semantic.subject_source_step_v1 ENABLE ALWAYS TRIGGER subject_source_step_original;
ALTER TABLE semantic.subject_source_step_v1 ENABLE ALWAYS TRIGGER subject_source_step_truncate;

-- migrate:down
DO $$ BEGIN
  LOCK TABLE semantic.subject_source_preparation_v1 IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM semantic.subject_source_preparation_v1) THEN
    RAISE EXCEPTION 'Drain held Source preparations before rollback';
  END IF;
END $$;
DROP INDEX semantic.subject_prepared_original;
DROP TABLE semantic.subject_source_step_v1, semantic.subject_source_preparation_v1;
DROP FUNCTION semantic.guard_subject_source_cursor_v1(),semantic.subject_source_consumer_v1(jsonb);
