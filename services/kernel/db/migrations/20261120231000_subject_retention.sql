-- migrate:up
-- The registration owner serializes births and finite cleanup grants. This
-- installation can serve the co-located placement only. Activation is an
-- offline topology check, independent of Search protocol selection.
CREATE TABLE core.subject_retention_domain (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  fenced boolean NOT NULL DEFAULT false,
  registration_generation uuid,
  restore_generation uuid,
  store_identity text,
  CHECK ((store_identity IS NULL)=(restore_generation IS NULL)),
  CHECK ((registration_generation IS NULL)=(restore_generation IS NULL)),
  CHECK (revision=0 OR restore_generation IS NOT NULL)
);
INSERT INTO core.subject_retention_domain(singleton) VALUES(true);

CREATE TABLE core.subject_subscription_v1 (
  birth bigint PRIMARY KEY CHECK (birth>0),
  job uuid NOT NULL UNIQUE,
  bootstrap uuid NOT NULL UNIQUE,
  source_id uuid NOT NULL,
  configuration uuid NOT NULL,
  definition uuid NOT NULL,
  key_count integer NOT NULL CHECK (key_count BETWEEN 1 AND 64),
  meaning text NOT NULL CHECK (octet_length(meaning) BETWEEN 1 AND 128),
  consumer jsonb NOT NULL CHECK (octet_length(consumer::text)<=8192),
  generation bigint NOT NULL CHECK (generation>0),
  physical_target text NOT NULL CHECK (octet_length(physical_target) BETWEEN 1 AND 255),
  incarnation text NOT NULL CHECK (octet_length(incarnation) BETWEEN 1 AND 255),
  registration_generation uuid NOT NULL,
  restore_generation uuid NOT NULL,
  opened_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE core.subject_subscription_key_v1 (
  input_key text COLLATE "C" NOT NULL CHECK (octet_length(input_key) BETWEEN 1 AND 2048),
  birth bigint NOT NULL REFERENCES core.subject_subscription_v1,
  PRIMARY KEY(input_key,birth)
);

-- These are the original retention bounds. Further Source/Access evidence
-- can be bound to the same page identity in the capturing transaction.
CREATE TABLE core.subject_retention_page_v1 (
  birth bigint NOT NULL REFERENCES core.subject_subscription_v1,
  first_home integer NOT NULL CHECK (first_home BETWEEN 0 AND 4095),
  end_home integer NOT NULL CHECK (end_home<=4096 AND end_home-first_home BETWEEN 1 AND 32),
  cuts jsonb NOT NULL CHECK (jsonb_typeof(cuts)='array' AND jsonb_array_length(cuts)=end_home-first_home),
  PRIMARY KEY(birth,first_home)
);

-- One durable, finite authorization per home. Long minima resume at the last
-- inspected birth, under the same membership revision. A later birth restarts
-- the calculation without expanding the previously issued high waters.
CREATE TABLE core.subject_cleanup_v1 (
  home integer PRIMARY KEY CHECK (home BETWEEN 0 AND 4095),
  owner_epoch integer NOT NULL,
  home_generation uuid NOT NULL,
  restore_generation uuid NOT NULL,
  command_through bigint NOT NULL CHECK(command_through>=0),
  privacy_through bigint NOT NULL CHECK(privacy_through>=0),
  scan_revision bigint,
  after_birth bigint,
  command_min bigint,
  privacy_min bigint
);

CREATE INDEX subject_retention_creation_pin ON core.consumer_checkpoint(partition_no,position);
CREATE INDEX subject_retention_privacy_pin ON semantic.public_filter_home_enrollment(partition_no,source_position);

-- DBOS rotates its restore generation before a restored database accepts
-- work. Also reject a database clone or a promoted timeline at the store.
CREATE FUNCTION core.subject_retention_store_v1() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT c.system_identifier::text||'/'||d.oid::text||'/'||left(pg_walfile_name(pg_current_wal_insert_lsn()),8)
  FROM pg_control_system() c JOIN pg_database d ON d.datname=current_database()
$$;

CREATE FUNCTION core.enable_subject_retention_v1() RETURNS void LANGUAGE plpgsql AS $$
DECLARE generation uuid; restore uuid;
BEGIN
  LOCK TABLE core.partition IN SHARE MODE;
  PERFORM FROM core.subject_retention_domain WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing retention owner'; END IF;
  SELECT a.generation,r.restore_generation INTO STRICT generation,restore
    FROM core.partition p JOIN core.publication_authority_epoch a ON a.home_no=p.partition_no
    CROSS JOIN dbos.workflow_writer_fence_domain r
    WHERE p.partition_no=0 AND r.singleton AND p.write_state='active'
      AND (SELECT count(*) FROM core.partition h WHERE h.partition_no BETWEEN 0 AND 4095
        AND h.write_state='active' AND h.node=p.node)=4096;
  UPDATE core.subject_retention_domain SET registration_generation=generation,restore_generation=restore,
    store_identity=core.subject_retention_store_v1()
    WHERE singleton AND registration_generation IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retention owner already installed'; END IF;
END $$;

-- A moved/fenced home cannot subsequently participate in a local-only
-- topology by copying this owner's control rows. Requalification must drain
-- original memberships before installing another placement authority.
CREATE FUNCTION core.fence_subject_retention_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE core.subject_retention_domain SET fenced=true
    WHERE singleton AND registration_generation IS NOT NULL AND NOT fenced;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_retention_placement AFTER UPDATE OF node,write_state,epoch,moved_to ON core.partition
  FOR EACH ROW WHEN ((OLD.node,OLD.write_state,OLD.epoch,OLD.moved_to) IS DISTINCT FROM
    (NEW.node,NEW.write_state,NEW.epoch,NEW.moved_to))
  EXECUTE FUNCTION core.fence_subject_retention_placement();

-- Capture this high water inside the transaction that retains a privacy
-- interval's original subscriber set. A missing lineage yields NULL.
CREATE FUNCTION core.subject_membership_revision_v1() RETURNS bigint LANGUAGE sql VOLATILE AS $$
  SELECT d.revision FROM core.subject_retention_domain d
  JOIN core.publication_authority_epoch a ON a.home_no=0 AND a.generation=d.registration_generation
  JOIN dbos.workflow_writer_fence_domain r ON r.singleton AND r.restore_generation=d.restore_generation
  WHERE d.singleton AND NOT d.fenced AND d.store_identity=core.subject_retention_store_v1()
  FOR SHARE OF d,r
$$;

-- Membership inputs come from the original native job and immutable Source
-- definition. A bootstrap is reserved here before any observation is made.
CREATE FUNCTION core.open_subject_subscription_v1(wanted_job uuid,wanted_bootstrap uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE d core.subject_retention_domain; prior core.subject_subscription_v1; member record; next_birth bigint;
BEGIN
  SELECT * INTO STRICT d FROM core.subject_retention_domain WHERE singleton FOR UPDATE;
  SELECT j.job,j.physical_target,j.native_incarnation,j.generation,j.consumer,s.source_id,s.configuration,
    def.read_definition,def.release_digest,def.coverage_keys,
    (j.phase='subject' AND j.home=0 AND j.pass=1 AND j.after_id IS NULL AND j.bootstrap IS NULL
      AND j.observation IS NULL AND j.fence IS NULL) AS fresh
    INTO STRICT member
    FROM search.generation_publication j
    JOIN search.public_filter_target target ON (target.partition_no,target.physical_target,target.incarnation)=
      (0,j.physical_target,j.native_incarnation)
    JOIN semantic.public_filter_read_definition def ON (def.partition_no,def.read_definition)=
      (0,(j.binding->>'readDefinition')::uuid)
    JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=
      (0,def.source_id,def.configuration)
    JOIN core.partition p ON p.partition_no=0 AND p.write_state='active' AND p.epoch=s.owner_epoch
    JOIN core.publication_authority_epoch a ON a.home_no=0 AND a.generation=d.registration_generation
    JOIN dbos.workflow_writer_fence_domain r ON r.singleton AND r.restore_generation=d.restore_generation
    WHERE (j.partition_no,j.job)=(0,wanted_job) AND j.family='subjects' AND j.source_home=0
      AND j.binding=jsonb_build_object('source',jsonb_build_object('id',s.source_id,'configuration',s.configuration,
        'epoch',s.owner_epoch,'partition',0),'readDefinition',def.read_definition,'meaning',jsonb_build_object('digest',def.release_digest))
      AND (j.consumer->>'readDefinition',j.consumer->>'meaningDigest',j.consumer->>'physicalTarget',j.consumer->>'incarnation')=
        (def.read_definition::text,def.release_digest,j.physical_target,j.native_incarnation)
      AND NOT d.fenced AND d.store_identity=core.subject_retention_store_v1()
      AND cardinality(def.coverage_keys) BETWEEN 1 AND 64
      AND octet_length(def.coverage_keys::text)<=16384
      AND def.coverage_keys=ARRAY(SELECT DISTINCT k COLLATE "C" FROM unnest(def.coverage_keys) k ORDER BY 1)
      AND '["scope","catalogue-text"]'=ANY(def.coverage_keys)
    FOR SHARE OF j,target,s,def,r;
  SELECT * INTO prior FROM core.subject_subscription_v1 WHERE job=wanted_job;
  IF FOUND THEN
    IF prior.key_count<>cardinality(member.coverage_keys) OR (prior.bootstrap,prior.definition,prior.meaning,prior.source_id,prior.configuration,prior.consumer,
        prior.generation,prior.physical_target,prior.incarnation,prior.restore_generation,prior.registration_generation)
      IS DISTINCT FROM (wanted_bootstrap,member.read_definition,member.release_digest,member.source_id,
        member.configuration,member.consumer,member.generation,member.physical_target,member.native_incarnation,
        d.restore_generation,d.registration_generation)
      OR EXISTS (SELECT FROM unnest(member.coverage_keys) k WHERE NOT EXISTS (
        SELECT FROM core.subject_subscription_key_v1 WHERE (input_key,birth)=(k,prior.birth)))
      THEN RAISE EXCEPTION 'Original retention membership mismatch'; END IF;
    RETURN prior.birth;
  END IF;
  IF NOT member.fresh OR EXISTS (SELECT FROM semantic.public_filter_bootstrap WHERE (partition_no,bootstrap)=(0,wanted_bootstrap))
    THEN RAISE EXCEPTION 'Bootstrap predates retention'; END IF;
  UPDATE core.subject_retention_domain SET revision=revision+1 WHERE singleton RETURNING revision INTO next_birth;
  INSERT INTO core.subject_subscription_v1 VALUES(next_birth,wanted_job,wanted_bootstrap,member.source_id,
    member.configuration,member.read_definition,cardinality(member.coverage_keys),member.release_digest,member.consumer,member.generation,
    member.physical_target,member.native_incarnation,d.registration_generation,d.restore_generation);
  INSERT INTO core.subject_subscription_key_v1 SELECT k,next_birth FROM unnest(member.coverage_keys) k;
  RETURN next_birth;
END $$;

CREATE FUNCTION core.subject_retention_heads_v1(wanted_home integer)
RETURNS TABLE(home integer,epoch integer,generation uuid,restore uuid,command_base bigint,privacy_base bigint)
LANGUAGE sql STABLE AS $$
  SELECT h.partition_no,h.epoch,a.generation,r.restore_generation,h.position,n.position
  FROM core.subject_retention_domain d
  JOIN core.publication_authority_epoch reg ON reg.home_no=0 AND reg.generation=d.registration_generation
  JOIN dbos.workflow_writer_fence_domain r ON r.singleton AND r.restore_generation=d.restore_generation
  JOIN core.partition h ON h.partition_no=wanted_home AND h.write_state='active'
  JOIN core.publication_authority_epoch a ON a.home_no=h.partition_no
  JOIN semantic.public_filter_privacy_head n ON n.partition_no=h.partition_no AND n.owner_epoch=h.epoch
    AND NOT n.population_fenced
  WHERE d.singleton AND NOT d.fenced AND d.store_identity=core.subject_retention_store_v1()
$$;

-- The page is the persisted observation. There is no API accepting caller
-- positions. Exact retries resolve the original, including after head advance.
CREATE FUNCTION core.capture_subject_retention_page_v1(member_birth bigint,lo integer,hi integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE saved core.subject_retention_page_v1; cuts jsonb;
BEGIN
  IF lo IS NULL OR hi IS NULL OR lo<0 OR hi>4096 OR hi-lo NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'Invalid retention page'; END IF;
  PERFORM FROM core.subject_retention_domain WHERE singleton FOR SHARE;
  PERFORM FROM core.subject_subscription_v1 s JOIN core.subject_retention_domain d
    ON d.singleton AND (s.registration_generation,s.restore_generation)=(d.registration_generation,d.restore_generation)
    JOIN search.generation_publication j ON (j.partition_no,j.job,j.physical_target,j.native_incarnation,
      j.consumer,j.generation)=(0,s.job,s.physical_target,s.incarnation,s.consumer,s.generation)
    JOIN search.public_filter_target target ON (target.partition_no,target.physical_target,target.incarnation)=
      (0,s.physical_target,s.incarnation)
    JOIN semantic.public_filter_source src ON (src.partition_no,src.source_id,src.configuration)=
      (0,s.source_id,s.configuration)
    WHERE s.birth=member_birth AND s.opened_xid<>pg_current_xact_id() AND NOT d.fenced
      AND j.binding=jsonb_build_object('source',jsonb_build_object('id',src.source_id,'configuration',src.configuration,
        'epoch',src.owner_epoch,'partition',0),'readDefinition',s.definition,'meaning',jsonb_build_object('digest',s.meaning))
    FOR UPDATE OF s FOR SHARE OF j,target,src;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing committed retention membership'; END IF;
  SELECT * INTO saved FROM core.subject_retention_page_v1 WHERE (birth,first_home)=(member_birth,lo);
  IF FOUND AND saved.end_home<>hi THEN RAISE EXCEPTION 'Original page interval mismatch'; END IF;
  IF saved.birth IS NULL AND coalesce((SELECT end_home FROM core.subject_retention_page_v1
    WHERE birth=member_birth ORDER BY first_home DESC LIMIT 1),0)<>lo THEN RAISE EXCEPTION 'Retention page gap'; END IF;
  SELECT jsonb_agg(jsonb_build_object('home',h.home,'epoch',h.epoch,'generation',h.generation,
      'command',h.command_base::text,'privacy',h.privacy_base::text) ORDER BY h.home) INTO cuts
    FROM generate_series(lo,hi-1) i CROSS JOIN LATERAL core.subject_retention_heads_v1(i) h
    LEFT JOIN core.subject_cleanup_v1 c ON c.home=i
    WHERE (c.home IS NULL OR ((c.owner_epoch,c.home_generation,c.restore_generation)=(h.epoch,h.generation,h.restore)
      AND h.command_base>=c.command_through AND h.privacy_base>=c.privacy_through))
      AND (saved.birth IS NULL OR ((saved.cuts->(i-lo)->>'epoch')::integer=h.epoch
        AND (saved.cuts->(i-lo)->>'generation')::uuid=h.generation
        AND (saved.cuts->(i-lo)->>'command')::bigint>=coalesce(c.command_through,0)
        AND (saved.cuts->(i-lo)->>'privacy')::bigint>=coalesce(c.privacy_through,0)
        AND (saved.cuts->(i-lo)->>'command')::bigint<=h.command_base
        AND (saved.cuts->(i-lo)->>'privacy')::bigint<=h.privacy_base));
  IF jsonb_array_length(cuts) IS DISTINCT FROM hi-lo THEN RAISE EXCEPTION 'Retention home lineage or position changed'; END IF;
  IF saved.birth IS NOT NULL THEN RETURN saved.cuts; END IF;
  INSERT INTO core.subject_retention_page_v1 VALUES(member_birth,lo,hi,cuts);
  RETURN cuts;
END $$;

-- Maintenance only. Each call visits at most 32 memberships and seeks one
-- original page per membership. NULL means pending, including an unresolved
-- home. Neither a replay cursor nor a receiver ACK is a release condition.
CREATE FUNCTION core.advance_subject_cleanup_v1(wanted_home integer)
RETURNS core.subject_cleanup_v1 LANGUAGE plpgsql AS $$
DECLARE d core.subject_retention_domain; h record; c core.subject_cleanup_v1;
  m record; cut jsonb; last_birth bigint; cmd bigint; priv bigint;
BEGIN
  SELECT * INTO STRICT d FROM core.subject_retention_domain WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT h FROM core.subject_retention_heads_v1(wanted_home);
  SELECT * INTO c FROM core.subject_cleanup_v1 WHERE home=wanted_home;
  IF FOUND AND ((c.owner_epoch,c.home_generation,c.restore_generation)<>(h.epoch,h.generation,h.restore)
      OR c.command_through>h.command_base OR c.privacy_through>h.privacy_base) THEN
    RAISE EXCEPTION 'Cleanup lineage or position changed'; END IF;
  IF c.scan_revision=d.revision THEN
    last_birth:=c.after_birth; cmd:=least(c.command_min,h.command_base); priv:=least(c.privacy_min,h.privacy_base);
  ELSE
    last_birth:=0; cmd:=h.command_base; priv:=h.privacy_base;
  END IF;
  FOR m IN SELECT birth,registration_generation,restore_generation FROM core.subject_subscription_v1
    WHERE birth>last_birth ORDER BY birth LIMIT 32 LOOP
    SELECT p.cuts->(wanted_home-p.first_home) INTO cut FROM core.subject_retention_page_v1 p
      WHERE p.birth=m.birth AND p.first_home<=wanted_home ORDER BY p.first_home DESC LIMIT 1;
    IF (m.registration_generation,m.restore_generation)<>(d.registration_generation,h.restore)
       OR (cut->>'home',cut->>'epoch',cut->>'generation') IS DISTINCT FROM
          (wanted_home::text,h.epoch::text,h.generation::text)
       OR (cut->>'command')::bigint>h.command_base OR (cut->>'privacy')::bigint>h.privacy_base THEN RETURN NULL; END IF;
    cmd:=least(cmd,(cut->>'command')::bigint); priv:=least(priv,(cut->>'privacy')::bigint);
    last_birth:=m.birth;
  END LOOP;
  IF last_birth=d.revision THEN
    -- A live key can still need the joined command/write-basis tuple. Until
    -- privacy has a durable disposition, hold both grants at their previous
    -- values. The existing partial home index answers this with one seek.
    IF EXISTS (SELECT FROM semantic.public_filter_privacy_pending WHERE partition_no=wanted_home AND live) THEN
      cmd:=least(cmd,coalesce(c.command_through,0));
      priv:=least(priv,coalesce(c.privacy_through,0));
    END IF;
    -- Existing consumers still decide whether the specific record is disposable.
    SELECT least(cmd,(SELECT position FROM core.consumer_checkpoint WHERE partition_no=wanted_home
      ORDER BY position LIMIT 1)),
      least(priv,(SELECT source_position FROM semantic.public_filter_home_enrollment WHERE partition_no=wanted_home
      ORDER BY source_position LIMIT 1)) INTO cmd,priv;
    IF cmd<coalesce(c.command_through,0) OR priv<coalesce(c.privacy_through,0) THEN
      RAISE EXCEPTION 'Original base regressed behind issued permission'; END IF;
    IF (cmd,priv)=(c.command_through,c.privacy_through) AND c.scan_revision IS NULL THEN RETURN c; END IF;
  END IF;
  INSERT INTO core.subject_cleanup_v1 VALUES(wanted_home,h.epoch,h.generation,h.restore,
    CASE WHEN last_birth=d.revision THEN cmd ELSE coalesce(c.command_through,0) END,
    CASE WHEN last_birth=d.revision THEN priv ELSE coalesce(c.privacy_through,0) END,
    CASE WHEN last_birth<>d.revision THEN d.revision END,CASE WHEN last_birth<>d.revision THEN last_birth END,
    CASE WHEN last_birth<>d.revision THEN cmd END,CASE WHEN last_birth<>d.revision THEN priv END)
  ON CONFLICT(home) DO UPDATE SET command_through=excluded.command_through,privacy_through=excluded.privacy_through,
    scan_revision=excluded.scan_revision,after_birth=excluded.after_birth,
    command_min=excluded.command_min,privacy_min=excluded.privacy_min RETURNING * INTO c;
  IF c.scan_revision IS NOT NULL THEN RETURN NULL; END IF;
  RETURN c;
END $$;

-- Applied locally at the actual destructive mutation, including by old
-- binaries. The original owner/dispatch/erasure checks are additional.
CREATE FUNCTION core.subject_cleanup_allowed_v1(wanted_home integer,wanted_epoch integer,pos bigint,stream text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE d core.subject_retention_domain;
BEGIN
  SELECT * INTO STRICT d FROM core.subject_retention_domain WHERE singleton FOR SHARE;
  -- Explicit legacy installation, before the retention owner is enabled.
  IF d.restore_generation IS NULL THEN RETURN true; END IF;
  PERFORM FROM dbos.workflow_writer_fence_domain r
    JOIN semantic.public_filter_privacy_head n ON n.partition_no=wanted_home AND n.owner_epoch=wanted_epoch
      AND NOT n.population_fenced
    WHERE r.singleton AND r.restore_generation=d.restore_generation FOR SHARE OF r,n;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN EXISTS (SELECT FROM core.subject_cleanup_v1 c
    JOIN core.subject_retention_heads_v1(wanted_home) h ON (c.home,c.owner_epoch,c.home_generation,c.restore_generation)=
      (h.home,h.epoch,h.generation,h.restore)
    WHERE c.home=wanted_home AND c.owner_epoch=wanted_epoch AND c.command_through<=h.command_base
      AND c.privacy_through<=h.privacy_base AND pos>0 AND CASE stream
        WHEN 'command' THEN pos<=c.command_through AND NOT EXISTS (
          SELECT FROM core.consumer_checkpoint pin WHERE pin.partition_no=c.home
            AND pin.position<pos)
        WHEN 'privacy' THEN pos<=c.privacy_through AND NOT EXISTS (
          SELECT FROM semantic.public_filter_home_enrollment e WHERE e.partition_no=c.home AND e.source_position<pos)
        ELSE false END);
END $$;

CREATE FUNCTION core.guard_subject_retention_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_epoch integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    PERFORM FROM core.subject_retention_domain WHERE singleton AND restore_generation IS NULL FOR SHARE;
    IF FOUND THEN RETURN NULL; END IF;
  ELSE
    IF TG_ARGV[0]='privacy' THEN owner_epoch:=OLD.owner_epoch; ELSE owner_epoch:=OLD.epoch; END IF;
    IF core.subject_cleanup_allowed_v1(OLD.partition_no,owner_epoch,OLD.position,TG_ARGV[0]) THEN
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Original Subject subscription evidence retained' USING ERRCODE='23514';
END $$;

CREATE TRIGGER subject_retention_outbox BEFORE DELETE OR UPDATE OF partition_no,position,epoch,event_seq,event_count,
  id,type,subject,data,payload_state ON core.outbox FOR EACH ROW EXECUTE FUNCTION core.guard_subject_retention_v1('command');
-- requested_by and principal provenance may still be erased independently.
CREATE TRIGGER subject_retention_basis BEFORE DELETE OR UPDATE OF partition_no,transaction_id,epoch,position
  ON editorial.write_basis FOR EACH ROW EXECUTE FUNCTION core.guard_subject_retention_v1('command');
CREATE TRIGGER subject_retention_privacy BEFORE DELETE OR UPDATE ON semantic.public_filter_privacy_log
  FOR EACH ROW EXECUTE FUNCTION core.guard_subject_retention_v1('privacy');

CREATE FUNCTION core.retain_subject_original_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Subject subscription requires original retirement evidence' USING ERRCODE='23514'; END $$;
DO $$
DECLARE rel regclass;
BEGIN
  FOREACH rel IN ARRAY ARRAY['core.subject_subscription_v1'::regclass,'core.subject_subscription_key_v1'::regclass,
      'core.subject_retention_page_v1'::regclass] LOOP
    EXECUTE format('CREATE TRIGGER subject_retention_immutable BEFORE UPDATE OR DELETE ON %s
      FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1()',rel);
    EXECUTE format('CREATE TRIGGER subject_retention_truncate BEFORE TRUNCATE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1()',rel);
  END LOOP;
  FOREACH rel IN ARRAY ARRAY['core.subject_cleanup_v1'::regclass,'core.subject_retention_domain'::regclass] LOOP
    EXECUTE format('CREATE TRIGGER subject_retention_watermark BEFORE DELETE ON %s
      FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1()',rel);
    EXECUTE format('CREATE TRIGGER subject_retention_truncate BEFORE TRUNCATE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1()',rel);
  END LOOP;
  FOREACH rel IN ARRAY ARRAY['core.outbox'::regclass,'editorial.write_basis'::regclass,
      'semantic.public_filter_privacy_log'::regclass] LOOP
    EXECUTE format('CREATE TRIGGER subject_retention_truncate BEFORE TRUNCATE ON %s
      FOR EACH STATEMENT EXECUTE FUNCTION core.guard_subject_retention_v1()',rel);
  END LOOP;
END $$;

-- Logical replay and maintenance connections must encounter the same guards.
ALTER TABLE core.outbox ENABLE ALWAYS TRIGGER subject_retention_outbox;
ALTER TABLE core.outbox ENABLE ALWAYS TRIGGER subject_retention_truncate;
ALTER TABLE editorial.write_basis ENABLE ALWAYS TRIGGER subject_retention_basis;
ALTER TABLE editorial.write_basis ENABLE ALWAYS TRIGGER subject_retention_truncate;
ALTER TABLE semantic.public_filter_privacy_log ENABLE ALWAYS TRIGGER subject_retention_privacy;
ALTER TABLE semantic.public_filter_privacy_log ENABLE ALWAYS TRIGGER subject_retention_truncate;
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER subject_retention_placement;

-- migrate:down
DO $$ BEGIN
  PERFORM FROM core.subject_retention_domain WHERE singleton FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT FROM core.subject_retention_domain WHERE restore_generation IS NOT NULL)
    THEN RAISE EXCEPTION 'Drain installed Subject retention before rollback'; END IF;
END $$;
DROP TRIGGER subject_retention_placement ON core.partition;
DROP TRIGGER subject_retention_outbox ON core.outbox;
DROP TRIGGER subject_retention_truncate ON core.outbox;
DROP TRIGGER subject_retention_basis ON editorial.write_basis;
DROP TRIGGER subject_retention_truncate ON editorial.write_basis;
DROP TRIGGER subject_retention_privacy ON semantic.public_filter_privacy_log;
DROP TRIGGER subject_retention_truncate ON semantic.public_filter_privacy_log;
DROP FUNCTION core.guard_subject_retention_v1(),core.subject_cleanup_allowed_v1(integer,integer,bigint,text),
  core.advance_subject_cleanup_v1(integer),core.capture_subject_retention_page_v1(bigint,integer,integer),
  core.subject_retention_heads_v1(integer),core.open_subject_subscription_v1(uuid,uuid),
  core.fence_subject_retention_placement(),core.enable_subject_retention_v1(),core.subject_membership_revision_v1(),
  core.subject_retention_store_v1();
DROP INDEX core.subject_retention_creation_pin, semantic.subject_retention_privacy_pin;
DROP TABLE core.subject_cleanup_v1,core.subject_retention_page_v1,core.subject_subscription_key_v1,
  core.subject_subscription_v1,core.subject_retention_domain;
DROP FUNCTION core.retain_subject_original_v1();
