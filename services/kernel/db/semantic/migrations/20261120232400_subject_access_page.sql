-- migrate:up
-- The Core page owns the command/privacy bounds. Its companion keeps Access
-- revisions at the same instant even though a Subject job consumes no Accounts.
CREATE TABLE semantic.subject_access_page_v1 (
  birth bigint NOT NULL,
  first_home integer NOT NULL,
  end_home integer NOT NULL CHECK (end_home<=4096 AND end_home-first_home BETWEEN 1 AND 32),
  cuts jsonb NOT NULL,
  definition_digest text NOT NULL,
  captured_xid xid8 NOT NULL,
  PRIMARY KEY (birth,first_home),
  FOREIGN KEY (birth,first_home) REFERENCES core.subject_retention_page_v1,
  CHECK (jsonb_typeof(cuts)='array' AND jsonb_array_length(cuts)=end_home-first_home)
);

-- Seek the original closure by birth as well as the reverse lookup used by
-- privacy fanout. Checking one extra key detects an overfilled membership.
CREATE INDEX subject_access_original_keys ON core.subject_subscription_key_v1(birth,input_key);

-- Acquire the publication and definition rows before the Account writer
-- locks. The retention-domain lock held by the caller excludes movement of
-- the registration home. Core rechecks its stream and placement authorities.
CREATE FUNCTION semantic.subject_access_definition_v1(member_birth bigint)
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(def.capture_digest,def.coverage_keys)::text,'UTF8')),'hex')
  FROM core.subject_subscription_v1 s
  JOIN search.generation_publication j ON (j.partition_no,j.job,j.physical_target,j.native_incarnation,j.consumer,j.generation)=
    (0,s.job,s.physical_target,s.incarnation,s.consumer,s.generation)
  JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=(0,s.physical_target,s.incarnation)
  JOIN semantic.public_filter_source src ON (src.partition_no,src.source_id,src.configuration)=(0,s.source_id,s.configuration)
  JOIN core.partition reg ON reg.partition_no=0 AND reg.write_state='active' AND reg.epoch=src.owner_epoch
  JOIN semantic.public_filter_read_definition def ON (def.partition_no,def.read_definition,def.source_id,def.configuration,
    def.release_digest)=(0,s.definition,s.source_id,s.configuration,s.meaning)
  WHERE s.birth=member_birth AND j.family='subjects' AND j.source_home=0
    AND cardinality(def.coverage_keys)=s.key_count AND octet_length(def.coverage_keys::text)<=16384
    AND def.coverage_keys=ARRAY(SELECT closure.input_key FROM (
      SELECT k.input_key FROM core.subject_subscription_key_v1 k WHERE k.birth=s.birth LIMIT 65
    ) closure ORDER BY closure.input_key)
    AND j.binding=jsonb_build_object('source',jsonb_build_object('id',src.source_id,'configuration',src.configuration,
      'epoch',src.owner_epoch,'partition',0),'readDefinition',s.definition,'meaning',jsonb_build_object('digest',s.meaning))
  FOR SHARE OF j,t,src,def
$$;

-- The ordinary Account/claim writer commits both revisions and the coalesced
-- enqueue together. An untouched home has no pending row and a zero carry.
CREATE FUNCTION semantic.subject_access_heads_v1(wanted_home integer,wanted_epoch integer)
RETURNS TABLE(account_revision bigint,claim_revision bigint,enqueue_revision bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.revision,a.claim_revision,coalesce(p.enqueue_revision,0)
  FROM (SELECT partition_no,revision,claim_revision FROM access.account_discovery_population
    WHERE partition_no=wanted_home LIMIT 1) a
  LEFT JOIN LATERAL (SELECT partition_no,owner_epoch,native_revision,native_claim_revision,enqueue_revision
    FROM semantic.public_filter_privacy_pending
    WHERE (partition_no,input_key)=(a.partition_no,'["domain","accounts"]') LIMIT 1) p ON true
  WHERE a.revision>0 AND a.claim_revision>0
    AND (p.partition_no IS NULL OR (p.owner_epoch,p.native_revision,p.native_claim_revision)=
      (wanted_epoch,a.revision,a.claim_revision))
$$;

-- Derive the entire payload in the database for every insert, including direct
-- writes. Never attach a later Account observation to an existing bare Core cut.
CREATE FUNCTION semantic.bind_subject_access_page_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original jsonb; homes_locked integer;
BEGIN
  IF NEW.first_home IS NULL OR NEW.end_home IS NULL OR NEW.first_home<0 OR NEW.end_home>4096
     OR NEW.end_home-NEW.first_home NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'Invalid Subject Access page interval'; END IF;
  PERFORM FROM core.subject_retention_domain WHERE singleton FOR SHARE;
  PERFORM FROM core.subject_subscription_v1 WHERE birth=NEW.birth FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing Subject membership'; END IF;
  IF EXISTS (SELECT FROM core.subject_retention_page_v1 WHERE (birth,first_home)=(NEW.birth,NEW.first_home))
    THEN RAISE EXCEPTION 'Core cut predates Subject Access page'; END IF;
  IF NEW.first_home<>coalesce((SELECT end_home FROM semantic.subject_access_page_v1
    WHERE birth=NEW.birth ORDER BY first_home DESC LIMIT 1),0)
    THEN RAISE EXCEPTION 'Subject Access page gap'; END IF;

  NEW.definition_digest:=semantic.subject_access_definition_v1(NEW.birth);
  IF NEW.definition_digest IS NULL THEN RAISE EXCEPTION 'Missing original Subject definition or membership keys'; END IF;

  -- Once these heads are held, ordinary Account and claim writers cannot
  -- change either revision or enqueue until the Core and Source pages commit.
  PERFORM FROM generate_series(NEW.first_home,NEW.end_home-1) h
    CROSS JOIN LATERAL (SELECT partition_no FROM access.account_discovery_population
      WHERE partition_no=h LIMIT 1 FOR SHARE) a;
  GET DIAGNOSTICS homes_locked = ROW_COUNT;
  IF homes_locked<>NEW.end_home-NEW.first_home THEN RAISE EXCEPTION 'Missing Subject Access population'; END IF;

  original:=core.capture_subject_retention_page_v1(NEW.birth,NEW.first_home,NEW.end_home);
  SELECT jsonb_agg(tuple || jsonb_build_object('receipt',
    encode(sha256(convert_to(jsonb_build_array('subject-access-v1',NEW.birth,NEW.first_home,NEW.end_home,NEW.definition_digest,tuple)::text,
      'UTF8')),'hex')) ORDER BY ordinal) INTO NEW.cuts
  FROM jsonb_array_elements(original) WITH ORDINALITY c(cut,ordinal)
  CROSS JOIN LATERAL semantic.subject_access_heads_v1((cut->>'home')::integer,(cut->>'epoch')::integer) a
  CROSS JOIN LATERAL (SELECT cut || jsonb_build_object('account',a.account_revision::text,
    'claim',a.claim_revision::text,'enqueue',a.enqueue_revision::text) AS tuple) t;
  IF jsonb_array_length(NEW.cuts) IS DISTINCT FROM homes_locked THEN RAISE EXCEPTION 'Stale Subject Access carry'; END IF;
  NEW.captured_xid:=pg_current_xact_id();
  RETURN NEW;
END $$;

CREATE TRIGGER subject_access_bind BEFORE INSERT ON semantic.subject_access_page_v1
  FOR EACH ROW EXECUTE FUNCTION semantic.bind_subject_access_page_v1();
CREATE TRIGGER subject_access_immutable BEFORE UPDATE OR DELETE ON semantic.subject_access_page_v1
  FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_access_truncate BEFORE TRUNCATE ON semantic.subject_access_page_v1
  FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();
ALTER TABLE semantic.subject_access_page_v1 ENABLE ALWAYS TRIGGER subject_access_bind;
ALTER TABLE semantic.subject_access_page_v1 ENABLE ALWAYS TRIGGER subject_access_immutable;
ALTER TABLE semantic.subject_access_page_v1 ENABLE ALWAYS TRIGGER subject_access_truncate;

CREATE FUNCTION semantic.capture_subject_access_page_v1(member_birth bigint,lo integer,hi integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE saved semantic.subject_access_page_v1; original jsonb;
BEGIN
  -- Serialize both fresh calls and uncertain-commit retries with Core capture.
  PERFORM FROM core.subject_retention_domain WHERE singleton FOR SHARE;
  PERFORM FROM core.subject_subscription_v1 WHERE birth=member_birth FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing Subject membership'; END IF;
  SELECT * INTO saved FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=(member_birth,lo);
  IF NOT FOUND THEN
    INSERT INTO semantic.subject_access_page_v1(birth,first_home,end_home)
      VALUES(member_birth,lo,hi) RETURNING * INTO saved;
  ELSE
    IF saved.end_home IS DISTINCT FROM hi THEN RAISE EXCEPTION 'Original Subject Access interval mismatch'; END IF;
    IF semantic.subject_access_definition_v1(member_birth) IS DISTINCT FROM saved.definition_digest
      THEN RAISE EXCEPTION 'Original Subject definition or membership keys changed'; END IF;
    original:=core.capture_subject_retention_page_v1(member_birth,lo,hi);
    IF (SELECT count(*) FROM jsonb_array_elements(saved.cuts) WITH ORDINALITY s(cut,ordinal)
      CROSS JOIN LATERAL semantic.subject_access_heads_v1((cut->>'home')::integer,(cut->>'epoch')::integer) a
      WHERE cut @> (original->(ordinal::integer-1)) AND a.account_revision >= (cut->>'account')::bigint
        AND a.claim_revision >= (cut->>'claim')::bigint AND a.enqueue_revision >= (cut->>'enqueue')::bigint
        AND (a.enqueue_revision > (cut->>'enqueue')::bigint OR (a.account_revision,a.claim_revision)=
          ((cut->>'account')::bigint,(cut->>'claim')::bigint)))<>hi-lo
      THEN RAISE EXCEPTION 'Original Subject Access authority changed'; END IF;
  END IF;
  RETURN saved.cuts;
END $$;

-- A single indexed predecessor seek resolves the original home and applies
-- Core, Access, Source and job lineage in the caller's inventory/replay snapshot.
CREATE FUNCTION semantic.subject_access_cut_v1(wanted_bootstrap uuid,wanted_home integer)
RETURNS TABLE(birth bigint,home integer,epoch integer,generation uuid,command_base bigint,privacy_base bigint,
  account_revision bigint,claim_revision bigint,enqueue_revision bigint,receipt text,command_head bigint,privacy_head bigint)
LANGUAGE sql STABLE AS $$
  SELECT s.birth,h.home,h.epoch,h.generation,(cut->>'command')::bigint,(cut->>'privacy')::bigint,
    (cut->>'account')::bigint,(cut->>'claim')::bigint,(cut->>'enqueue')::bigint,cut->>'receipt',
    h.command_base,h.privacy_base
  FROM core.subject_subscription_v1 s
  JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced AND
    (s.registration_generation,s.restore_generation)=(d.registration_generation,d.restore_generation)
  JOIN LATERAL (SELECT * FROM search.generation_publication
    WHERE (partition_no,job,physical_target,consumer)=(0,s.job,s.physical_target,s.consumer) LIMIT 1) j ON (j.physical_target,j.native_incarnation,j.consumer,j.generation)=
    (s.physical_target,s.incarnation,s.consumer,s.generation) AND j.family='subjects' AND j.source_home=0
  JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=(0,s.physical_target,s.incarnation)
  JOIN semantic.public_filter_source src ON (src.partition_no,src.source_id,src.configuration)=(0,s.source_id,s.configuration)
  JOIN core.partition reg ON reg.partition_no=0 AND reg.write_state='active' AND reg.epoch=src.owner_epoch
  JOIN LATERAL (SELECT * FROM semantic.public_filter_read_definition
    WHERE (partition_no,read_definition)=(0,s.definition) LIMIT 1) def ON (def.source_id,def.configuration,def.release_digest)=
    (s.source_id,s.configuration,s.meaning)
  CROSS JOIN LATERAL (SELECT * FROM semantic.subject_access_page_v1 p
    WHERE p.birth=s.birth AND p.first_home<=wanted_home ORDER BY p.first_home DESC LIMIT 1) page
  JOIN core.subject_retention_page_v1 p ON (p.birth,p.first_home,p.end_home)=(page.birth,page.first_home,page.end_home)
  CROSS JOIN LATERAL (SELECT page.cuts->(wanted_home-page.first_home) AS cut) entry
  CROSS JOIN core.subject_retention_heads_v1(wanted_home) h
  CROSS JOIN LATERAL semantic.subject_access_heads_v1(wanted_home,h.epoch) a
  LEFT JOIN core.subject_cleanup_v1 permit ON permit.home=wanted_home
  WHERE s.bootstrap=wanted_bootstrap AND wanted_home>=0 AND wanted_home<page.end_home
    AND page.captured_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
    AND j.binding=jsonb_build_object('source',jsonb_build_object('id',src.source_id,'configuration',src.configuration,
      'epoch',src.owner_epoch,'partition',0),'readDefinition',s.definition,'meaning',jsonb_build_object('digest',s.meaning))
    AND cardinality(def.coverage_keys)=s.key_count AND octet_length(def.coverage_keys::text)<=16384
    AND def.coverage_keys=ARRAY(SELECT closure.input_key FROM (
      SELECT k.input_key FROM core.subject_subscription_key_v1 k WHERE k.birth=s.birth LIMIT 65
    ) closure ORDER BY closure.input_key)
    AND page.definition_digest=encode(sha256(convert_to(jsonb_build_array(def.capture_digest,def.coverage_keys)::text,
      'UTF8')),'hex')
    AND cut @> (p.cuts->(wanted_home-page.first_home))
    AND (cut->>'home',cut->>'epoch',cut->>'generation')=(h.home::text,h.epoch::text,h.generation::text)
    AND h.command_base >= (cut->>'command')::bigint AND h.privacy_base >= (cut->>'privacy')::bigint
    AND a.account_revision >= (cut->>'account')::bigint AND a.claim_revision >= (cut->>'claim')::bigint
    AND a.enqueue_revision >= (cut->>'enqueue')::bigint
    AND (a.enqueue_revision > (cut->>'enqueue')::bigint OR (a.account_revision,a.claim_revision)=
      ((cut->>'account')::bigint,(cut->>'claim')::bigint))
    AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=
      (h.epoch,h.generation,h.restore) AND permit.command_through <= (cut->>'command')::bigint
      AND permit.privacy_through <= (cut->>'privacy')::bigint))
$$;

-- migrate:down
DO $$ BEGIN
  LOCK TABLE semantic.subject_access_page_v1 IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM semantic.subject_access_page_v1) THEN
    RAISE EXCEPTION 'Retire original Subject Access pages before rollback'; END IF;
END $$;
DROP FUNCTION semantic.subject_access_cut_v1(uuid,integer),semantic.capture_subject_access_page_v1(bigint,integer,integer);
DROP TABLE semantic.subject_access_page_v1;
DROP FUNCTION semantic.bind_subject_access_page_v1(),semantic.subject_access_heads_v1(integer,integer),
  semantic.subject_access_definition_v1(bigint);
DROP INDEX core.subject_access_original_keys;
