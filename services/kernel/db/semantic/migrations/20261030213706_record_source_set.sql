-- migrate:up
-- Only native keys are retained. No content, account attribution or history payload vector.
CREATE TABLE semantic.record_source_set (
 partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
 route integer GENERATED ALWAYS AS (partition_no*16) STORED,
 transaction_id uuid NOT NULL,
 revision integer GENERATED ALWAYS AS IDENTITY,
 native_xid text NOT NULL DEFAULT pg_current_xact_id()::text,
 sealed boolean NOT NULL DEFAULT false,
 digest text,
 members integer NOT NULL DEFAULT 0 CHECK (members BETWEEN 0 AND 512),
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,transaction_id),
 UNIQUE(partition_no,transaction_id,revision),
 CHECK ((sealed AND digest ~ '^[0-9a-f]{64}$') OR (NOT sealed AND digest IS NULL))
);
CREATE UNIQUE INDEX record_source_set_erasure_key ON semantic.record_source_set(erasure_key,route);
CREATE TABLE semantic.record_source_set_member (
 partition_no integer NOT NULL,
 route integer GENERATED ALWAYS AS (partition_no*16) STORED,
 transaction_id uuid NOT NULL,
 unit_key text COLLATE "C" NOT NULL,
 source_key text COLLATE "C" NOT NULL,
 source_hash bytea NOT NULL,
 unit_hash bytea NOT NULL,
 kind text NOT NULL CHECK(kind IN ('contribution','terms')),
 subject_id uuid NOT NULL,
 candidate_id uuid,
 source_revision integer NOT NULL CHECK(source_revision>0),
 document_id uuid,
 field text,
 language text,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,transaction_id,source_hash),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.record_source_set(partition_no,transaction_id),
 CHECK ((kind='contribution' AND candidate_id IS NOT NULL AND field IS NULL AND language IS NULL)
 OR (kind='terms' AND candidate_id IS NULL AND document_id IS NULL
 AND field IN ('labels','descriptions','aliases') AND language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'))
);
CREATE UNIQUE INDEX record_source_set_member_erasure_key ON semantic.record_source_set_member(erasure_key,route);
CREATE INDEX record_source_set_member_lookup ON semantic.record_source_set_member(partition_no,source_hash,transaction_id);
CREATE INDEX record_source_set_member_unit ON semantic.record_source_set_member(partition_no,transaction_id,unit_hash,source_revision);

CREATE INDEX record_source_set_member_version ON semantic.record_source_set_member
 (partition_no,transaction_id,subject_id,candidate_id,source_revision);

CREATE FUNCTION semantic.guard_record_source_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner semantic.record_source_set;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable Semantic record source set'; END IF;
 IF TG_TABLE_NAME='record_source_set' THEN
  IF TG_OP='UPDATE' AND (OLD.sealed OR OLD.native_xid<>pg_current_xact_id()::text
    OR (NEW.partition_no,NEW.transaction_id,NEW.revision,NEW.native_xid,NEW.erasure_key)
      IS DISTINCT FROM (OLD.partition_no,OLD.transaction_id,OLD.revision,OLD.native_xid,OLD.erasure_key)) THEN
   RAISE EXCEPTION 'Immutable Semantic record source set';
  END IF;
 ELSE
  SELECT * INTO STRICT owner FROM semantic.record_source_set
    WHERE partition_no=NEW.partition_no AND transaction_id=NEW.transaction_id;
  IF TG_OP<>'INSERT' OR owner.sealed OR owner.native_xid<>pg_current_xact_id()::text THEN
   RAISE EXCEPTION 'Immutable Semantic record source set membership';
  END IF;
  NEW.source_hash:=sha256(convert_to(NEW.source_key,'UTF8'));
  NEW.unit_hash:=sha256(convert_to(NEW.unit_key,'UTF8'));
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_source_set_immutable BEFORE UPDATE OR DELETE ON semantic.record_source_set
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_record_source_set();
CREATE TRIGGER record_source_set_member_immutable BEFORE INSERT OR UPDATE OR DELETE ON semantic.record_source_set_member
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_record_source_set();

CREATE FUNCTION semantic.append_record_source_set(p_home integer,p_tx uuid,p_revision integer,p_input jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner semantic.record_source_set; entry jsonb; n integer; revisions integer;
BEGIN
 SELECT * INTO STRICT owner FROM semantic.record_source_set
 WHERE partition_no=p_home AND transaction_id=p_tx AND revision=p_revision FOR UPDATE;
 IF owner.sealed OR owner.native_xid<>pg_current_xact_id()::text THEN
  RAISE EXCEPTION 'Semantic record source set is not building';
 END IF;
 IF jsonb_array_length(p_input)>512 THEN RAISE EXCEPTION 'Semantic source append exceeds 512 inputs'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_input) LOOP
  INSERT INTO semantic.record_source_set_member(partition_no,transaction_id,unit_key,source_key,kind,
    subject_id,candidate_id,source_revision,document_id,field,language)
  VALUES(p_home,p_tx,entry->>'unit',entry->>'key',entry->>'kind',(entry->>'subject')::uuid,
    (entry->>'candidate')::uuid,(entry->>'revision')::integer,(entry->>'document')::uuid,
    entry->>'field',entry->>'language') ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM semantic.record_source_set_member WHERE partition_no=p_home AND transaction_id=p_tx
   AND source_hash=sha256(convert_to(entry->>'key','UTF8')) AND source_key=entry->>'key') THEN
   RAISE EXCEPTION 'Semantic source key collision';
  END IF;
 END LOOP;
 SELECT count(DISTINCT unit_key) INTO n FROM semantic.record_source_set_member
 WHERE partition_no=p_home AND transaction_id=p_tx;
 IF n>512 THEN RAISE EXCEPTION 'Semantic command exceeds the existing 512 source-member bound'; END IF;
 -- One old/current pair per actual contribution/document reference or term field/language unit.
 SELECT max(versions) INTO revisions FROM (
  SELECT count(DISTINCT source_revision) versions FROM semantic.record_source_set_member
  WHERE partition_no=p_home AND transaction_id=p_tx GROUP BY unit_key
 ) counted;
 IF revisions>2 THEN RAISE EXCEPTION 'Semantic source unit exceeds an old/current pair'; END IF;
END; $$;

-- Resolve source revisions by their native transaction, independent of unrelated slot history.
CREATE INDEX record_source_set_fact_origin ON semantic.fact(route,subject_id,recorded_transaction_id,kind,statement_id);

CREATE FUNCTION semantic.seal_record_source_set(p_home integer,p_tx uuid,p_revision integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner semantic.record_source_set; member semantic.record_source_set_member; native_route integer;
 native_body jsonb; n integer; calculated text;
BEGIN
 SELECT * INTO STRICT owner FROM semantic.record_source_set
 WHERE partition_no=p_home AND transaction_id=p_tx AND revision=p_revision FOR UPDATE;
 IF owner.sealed OR owner.native_xid<>pg_current_xact_id()::text THEN
  RAISE EXCEPTION 'Semantic record source set is not building';
 END IF;
 -- Resolve each actual version once. A point reference to an original document does not
 -- assert that its entire containing snapshot was copied by this command.
 FOR member IN SELECT DISTINCT ON(subject_id,candidate_id,source_revision,field,language) *
  FROM semantic.record_source_set_member WHERE partition_no=p_home AND transaction_id=p_tx
  ORDER BY subject_id,candidate_id,source_revision,field,language,document_id NULLS FIRST LOOP
  native_route:=(get_byte(uuid_send(member.subject_id),10)*256+get_byte(uuid_send(member.subject_id),11));
  IF native_route/16<>p_home THEN RAISE EXCEPTION 'Semantic source is outside native command home'; END IF;
  IF member.kind='contribution' THEN
   SELECT c.statement INTO native_body FROM semantic.candidate c WHERE c.route=native_route
    AND c.subject_id=member.subject_id AND c.candidate_id=member.candidate_id AND c.revision=member.source_revision;
   IF NOT FOUND THEN
    SELECT f.body INTO native_body FROM semantic.fact f JOIN semantic.revision r
      ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
    WHERE f.route=native_route AND f.subject_id=member.subject_id AND f.statement_id=member.candidate_id
      AND f.kind='statement' AND f.operation='assert' AND r.revision=member.source_revision LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown native Semantic contribution source'; END IF;
   END IF;
   IF EXISTS(
    WITH expected AS MATERIALIZED (
     SELECT value #>> '{}' AS id FROM jsonb_path_query(native_body,'$.value.content.document') AS document(value)
     UNION SELECT value #>> '{}' FROM jsonb_path_query(native_body,'$.qualifiers[*].value.content.document') AS document(value)
     UNION SELECT value #>> '{}' FROM jsonb_path_query(native_body,'$.references[*].parts[*].value.content.document') AS document(value)
    ), collected AS MATERIALIZED (
     SELECT document_id::text AS id FROM semantic.record_source_set_member m
     WHERE m.partition_no=p_home AND m.transaction_id=p_tx AND m.kind='contribution'
      AND m.subject_id=member.subject_id AND m.candidate_id=member.candidate_id
      AND m.source_revision=member.source_revision AND m.document_id IS NOT NULL
    )
    SELECT 1 FROM (
     (SELECT id FROM expected WHERE member.document_id IS NULL EXCEPT SELECT id FROM collected)
     UNION ALL (SELECT id FROM collected EXCEPT SELECT id FROM expected)) mismatch
   ) THEN RAISE EXCEPTION 'Semantic contribution source omitted or invented a native document'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM semantic.fact f JOIN semantic.revision r
    ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
    WHERE f.route=native_route AND f.subject_id=member.subject_id AND r.revision=member.source_revision
      AND f.kind=CASE member.field WHEN 'labels' THEN 'label' WHEN 'descriptions' THEN 'description' ELSE 'alias' END
      AND f.language=member.language) THEN RAISE EXCEPTION 'Unknown native Semantic term source'; END IF;
  END IF;
 END LOOP;
 SELECT count(DISTINCT unit_key),encode(sha256(convert_to(coalesce(string_agg(source_key,E'\n' ORDER BY source_key),''),'UTF8')),'hex')
 INTO n,calculated FROM semantic.record_source_set_member WHERE partition_no=p_home AND transaction_id=p_tx;
 UPDATE semantic.record_source_set SET sealed=true,members=n,digest=calculated
 WHERE partition_no=p_home AND transaction_id=p_tx;
END; $$;

CREATE FUNCTION semantic.commit_record_source_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved semantic.record_source_set;
BEGIN
 SELECT * INTO STRICT saved FROM semantic.record_source_set
  WHERE partition_no=NEW.partition_no AND transaction_id=NEW.transaction_id;
 IF NOT saved.sealed OR saved.native_xid<>pg_current_xact_id()::text OR NOT EXISTS(
  SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=saved.partition_no AND b.transaction_id=saved.transaction_id
    AND b.xmin=pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'Semantic record source set requires a sealed native current command' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER record_source_set_commit AFTER INSERT ON semantic.record_source_set
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.commit_record_source_set();

-- Every native fact/candidate actually serialized by the building command must be enrolled.
-- Old copied snapshots are enrolled by the native reader/writer hooks before their serializers.
CREATE FUNCTION semantic.require_record_source_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner semantic.record_source_set; v_revision integer; v_candidate uuid; v_kind text; v_field text; v_language text;
BEGIN
 SELECT * INTO owner FROM semantic.record_source_set
 WHERE partition_no=NEW.route/16 AND native_xid=pg_current_xact_id()::text;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='candidate' THEN
  v_revision:=NEW.revision; v_candidate:=NEW.candidate_id; v_kind:='contribution';
 ELSE
  IF NEW.operation='expand' THEN RETURN NEW; END IF;
  SELECT r.revision INTO v_revision FROM semantic.revision r WHERE r.route=NEW.route
   AND r.subject_id=NEW.subject_id AND r.recorded_transaction_id=NEW.recorded_transaction_id;
  v_candidate:=NEW.statement_id; v_language:=NEW.language;
  v_kind:=CASE WHEN NEW.kind='statement' THEN 'contribution' ELSE 'terms' END;
  v_field:=CASE NEW.kind WHEN 'label' THEN 'labels' WHEN 'description' THEN 'descriptions' WHEN 'alias' THEN 'aliases' END;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM semantic.record_source_set_member m WHERE m.partition_no=owner.partition_no
  AND m.transaction_id=owner.transaction_id AND m.kind=v_kind AND m.subject_id=NEW.subject_id
  AND m.source_revision=v_revision AND m.candidate_id IS NOT DISTINCT FROM v_candidate
  AND ((v_kind='contribution' AND m.document_id IS NULL) OR (v_kind='terms' AND m.field=v_field AND m.language=v_language))) THEN
  RAISE EXCEPTION 'Semantic record source set omitted an actual native source unit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER record_source_fact_member AFTER INSERT ON semantic.fact
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.require_record_source_member();
CREATE CONSTRAINT TRIGGER record_source_candidate_member AFTER INSERT ON semantic.candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.require_record_source_member();
CREATE INDEX record_source_set_native_transaction ON semantic.record_source_set(partition_no,native_xid);

CREATE FUNCTION semantic.capture_record_source_set_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row record; role_row record; native_route integer;
BEGIN
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 IF TG_TABLE_NAME='record_source_set_member' THEN
  native_route:=(get_byte(uuid_send(NEW.subject_id),10)*256+get_byte(uuid_send(NEW.subject_id),11));
  FOR source_row IN
   SELECT 'candidate' store,c.erasure_key FROM semantic.candidate c WHERE c.route=native_route
    AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id AND c.revision=NEW.source_revision
   UNION ALL
   SELECT 'fact',f.erasure_key FROM semantic.fact f JOIN semantic.revision r
    ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
   WHERE f.route=native_route AND f.subject_id=NEW.subject_id AND r.revision=NEW.source_revision
    AND ((NEW.kind='contribution' AND f.statement_id=NEW.candidate_id) OR
      (NEW.kind='terms' AND f.language=NEW.language AND f.kind=CASE NEW.field
        WHEN 'labels' THEN 'label' WHEN 'descriptions' THEN 'description' ELSE 'alias' END))
  LOOP
   FOR role_row IN SELECT account_id,role FROM semantic.erasure_locator WHERE partition_no=NEW.partition_no
    AND store=source_row.store AND record_key=source_row.erasure_key LOOP
    PERFORM semantic.record_erasure_locator(NEW.partition_no,role_row.account_id,role_row.role,
      TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id,NULL);
   END LOOP;
  END LOOP;
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER record_source_set_erasure AFTER INSERT ON semantic.record_source_set
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_source_set_erasure();
CREATE CONSTRAINT TRIGGER record_source_set_member_erasure AFTER INSERT ON semantic.record_source_set_member
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_source_set_erasure();
-- Extend the existing exact-key inventory rather than creating another inventory or receiving receipt.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('semantic.capture_erasure_source_record()'::regprocedure) INTO definition;
 definition:=replace(definition,'ELSE v_present:=false;',
 'WHEN ''record_source_set'' THEN SELECT true INTO v_present FROM semantic.record_source_set WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN ''record_source_set_member'' THEN SELECT true,subject_id,candidate_id INTO v_present,v_original,v_candidate FROM semantic.record_source_set_member WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 ELSE v_present:=false;');
 EXECUTE definition;
END; $migration$;

-- migrate:down
-- The additive inventory cases must be removed before dropping the native stores.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('semantic.capture_erasure_source_record()'::regprocedure) INTO definition;
 definition:=replace(definition,
 'WHEN ''record_source_set'' THEN SELECT true INTO v_present FROM semantic.record_source_set WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN ''record_source_set_member'' THEN SELECT true,subject_id,candidate_id INTO v_present,v_original,v_candidate FROM semantic.record_source_set_member WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 ELSE v_present:=false;', 'ELSE v_present:=false;');
 EXECUTE definition;
END; $migration$;
DROP TRIGGER record_source_fact_member ON semantic.fact;
DROP TRIGGER record_source_candidate_member ON semantic.candidate;
DROP FUNCTION semantic.require_record_source_member();
DROP TABLE semantic.record_source_set_member;
DROP TABLE semantic.record_source_set;
DROP FUNCTION semantic.capture_record_source_set_erasure();
DROP FUNCTION semantic.commit_record_source_set();
DROP FUNCTION semantic.seal_record_source_set(integer,uuid,integer);
DROP INDEX semantic.record_source_set_fact_origin;
DROP FUNCTION semantic.append_record_source_set(integer,uuid,integer,jsonb);
DROP FUNCTION semantic.guard_record_source_set();
