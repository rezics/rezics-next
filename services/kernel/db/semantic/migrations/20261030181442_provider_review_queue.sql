-- migrate:up
-- Discovery keys stay separate from candidate values and authorization. Source capture is local to the
-- original native transaction; the existing worker transfers only exact keys and native erasure roles.
CREATE TABLE semantic.provider_review_queue_key (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  captured_position bigint NOT NULL,
  published boolean NOT NULL DEFAULT false,
  erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
  PRIMARY KEY(route,source,subject_id,candidate_id),
  CHECK (route=get_byte(uuid_send(subject_id),10)*256+get_byte(uuid_send(subject_id),11))
);
CREATE UNIQUE INDEX provider_review_queue_key_erasure ON semantic.provider_review_queue_key(route,erasure_key);
CREATE INDEX provider_review_queue_key_pending ON semantic.provider_review_queue_key(route,captured_position,erasure_key) WHERE NOT published;
CREATE INDEX source_candidate_provider_review ON semantic.source_candidate(route,source,erasure_key);

CREATE TABLE semantic.provider_review_queue_entry (
  route integer NOT NULL CHECK (route=0),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
  PRIMARY KEY(route,source,subject_id,candidate_id)
);
CREATE UNIQUE INDEX provider_review_queue_entry_erasure ON semantic.provider_review_queue_entry(route,erasure_key);

-- Numeric source ordinals are private maintenance positions, not public cursors or account identifiers.
CREATE TABLE semantic.provider_review_queue_bootstrap (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  after_route integer NOT NULL,
  after_key bigint NOT NULL DEFAULT 0,
  source_epoch integer NOT NULL,
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY(partition_no,source),
  CHECK (after_route BETWEEN partition_no*16 AND partition_no*16+16)
);
CREATE TABLE semantic.provider_review_queue_ready (
  route integer NOT NULL CHECK (route=0),
  source text NOT NULL,
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL,
  PRIMARY KEY(route,source,source_partition)
);

-- Keep the candidate's native roles even if its original write basis was already minimized.
CREATE FUNCTION semantic.capture_provider_review_queue_roles(p_route integer,p_key bigint,p_subject uuid,p_candidate uuid,p_tx uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; n integer:=0;
BEGIN
  FOR r IN SELECT l.account_id,l.role FROM semantic.candidate c
    JOIN semantic.erasure_locator l ON l.partition_no=p_route/16 AND l.store='candidate' AND l.record_key=c.erasure_key
    WHERE c.route=p_route AND c.subject_id=p_subject AND c.candidate_id=p_candidate
    ORDER BY l.account_id,l.role LIMIT 9 LOOP
    n:=n+1;
    IF n>8 THEN RAISE EXCEPTION 'Provider candidate role bound exceeded'; END IF;
    INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
      VALUES(p_route/16,'provider_review_queue_key',p_key,p_tx,r.account_id,r.role) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM semantic.capture_erasure_roles(p_route/16,'provider_review_queue_key',p_key,p_tx);
END; $$;

CREATE FUNCTION semantic.capture_provider_review_queue_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid; k bigint; p bigint;
BEGIN
  IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
  SELECT r.recorded_transaction_id INTO native_tx FROM semantic.candidate c
    JOIN semantic.revision r USING(route,subject_id,revision)
    WHERE c.route=NEW.route AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id;
  IF native_tx IS NULL THEN RAISE EXCEPTION 'Provider candidate has no native provenance'; END IF;
  SELECT position INTO p FROM core.partition WHERE partition_no=NEW.route/16;
  INSERT INTO semantic.provider_review_queue_key(route,source,subject_id,candidate_id,recorded_transaction_id,captured_position)
    VALUES(NEW.route,NEW.source,NEW.subject_id,NEW.candidate_id,native_tx,p)
    ON CONFLICT(route,source,subject_id,candidate_id) DO NOTHING;
  SELECT erasure_key INTO k FROM semantic.provider_review_queue_key
    WHERE route=NEW.route AND source=NEW.source AND subject_id=NEW.subject_id AND candidate_id=NEW.candidate_id;
  PERFORM semantic.capture_provider_review_queue_roles(NEW.route,k,NEW.subject_id,NEW.candidate_id,native_tx);
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER provider_review_queue_capture AFTER INSERT OR UPDATE ON semantic.source_candidate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_provider_review_queue_key();

-- migrate:down
DROP TRIGGER provider_review_queue_capture ON semantic.source_candidate;
DROP FUNCTION semantic.capture_provider_review_queue_key();
DROP FUNCTION semantic.capture_provider_review_queue_roles(integer,bigint,uuid,uuid,uuid);
DROP TABLE semantic.provider_review_queue_ready;
DROP TABLE semantic.provider_review_queue_bootstrap;
DROP TABLE semantic.provider_review_queue_entry;
DROP TABLE semantic.provider_review_queue_key;
DROP INDEX semantic.source_candidate_provider_review;
