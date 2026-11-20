-- migrate:up
ALTER TABLE search.generation_publication ADD COLUMN subscription_protocol smallint NOT NULL DEFAULT 0
  CHECK (subscription_protocol=0 OR (subscription_protocol=1 AND ack_protocol=1 AND family='subjects' AND source_home=0));
ALTER TABLE semantic.public_filter_bootstrap ADD COLUMN subscription_protocol smallint NOT NULL DEFAULT 0
  CHECK (subscription_protocol=0 OR (subscription_protocol=1 AND snapshot_kind='prepared' AND partition_no=0));
ALTER TABLE search.public_filter_coverage_preparation ADD COLUMN subscription_protocol smallint NOT NULL DEFAULT 0
  CHECK (subscription_protocol=0 OR (subscription_protocol=1 AND ack_protocol=1 AND population_protocol=1));

CREATE TRIGGER subject_job_protocol BEFORE UPDATE OF subscription_protocol ON search.generation_publication
  FOR EACH ROW WHEN (NEW.subscription_protocol<>OLD.subscription_protocol) EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER subject_source_protocol BEFORE UPDATE OF subscription_protocol ON semantic.public_filter_bootstrap
  FOR EACH ROW WHEN (NEW.subscription_protocol<>OLD.subscription_protocol) EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER subject_receiver_protocol BEFORE UPDATE OF subscription_protocol ON search.public_filter_coverage_preparation
  FOR EACH ROW WHEN (NEW.subscription_protocol<>OLD.subscription_protocol) EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- The producer reserves its bootstrap from the membership before scanning.
CREATE FUNCTION search.pin_subject_source_format_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT coalesce((SELECT j.subscription_protocol FROM core.subject_subscription_v1 m
    JOIN search.generation_publication j ON (j.partition_no,j.job)=(0,m.job)
    WHERE m.bootstrap=NEW.bootstrap AND m.definition=NEW.read_definition AND NEW.snapshot_kind='prepared'
      AND semantic.public_filter_native_json(NEW.consumer::jsonb)=m.consumer),0) INTO NEW.subscription_protocol;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_source_format BEFORE INSERT ON semantic.public_filter_bootstrap
  FOR EACH ROW WHEN (NEW.snapshot_kind='prepared') EXECUTE FUNCTION search.pin_subject_source_format_v1();

CREATE FUNCTION search.require_subject_receiver_format_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE protocol smallint;
BEGIN
  SELECT b.subscription_protocol INTO protocol FROM semantic.public_filter_bootstrap b
    WHERE (b.partition_no,b.bootstrap)=(NEW.partition_no,NEW.bootstrap);
  IF NEW.subscription_protocol<>coalesce(protocol,0) OR (NEW.subscription_protocol=1 AND
    (NEW.after_home<>0 OR NEW.ack_retired OR NOT EXISTS (
      SELECT FROM core.subject_subscription_v1 s JOIN search.generation_publication j
        ON (j.partition_no,j.job,j.subscription_protocol)=(0,s.job,1)
      JOIN search.public_filter_registration r ON (r.partition_no,r.id,r.state)=(0,NEW.registration,'active')
      WHERE (s.bootstrap,s.definition,s.physical_target)=(NEW.bootstrap,NEW.definition,r.physical_target)
        AND NEW.consumer=r.consumer AND NEW.generation=r.coverage_generation
        AND semantic.public_filter_native_json(r.consumer::jsonb)=s.consumer))) THEN
    RAISE EXCEPTION 'Invalid original Subject receiver preparation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_receiver_format BEFORE INSERT ON search.public_filter_coverage_preparation
  FOR EACH ROW EXECUTE FUNCTION search.require_subject_receiver_format_v1();

CREATE TABLE search.subject_receiver_page_v1 (
  birth bigint NOT NULL,
  first_home integer NOT NULL,
  end_home integer NOT NULL CHECK (end_home<=4096 AND end_home-first_home BETWEEN 1 AND 32),
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  predecessor text NOT NULL,
  root text NOT NULL,
  cuts jsonb NOT NULL CHECK (jsonb_typeof(cuts)='array' AND jsonb_array_length(cuts)=end_home-first_home),
  adopted_by xid8 NOT NULL,
  PRIMARY KEY (birth,first_home),
  FOREIGN KEY (birth,first_home) REFERENCES core.subject_retention_page_v1
);
CREATE TRIGGER subject_receiver_page_original BEFORE UPDATE OR DELETE ON search.subject_receiver_page_v1
  FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_receiver_page_truncate BEFORE TRUNCATE ON search.subject_receiver_page_v1
  FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();

-- Reopen the exact committed Core/Access page under its membership and native
-- owner locks. Never let receiver adoption create the producer evidence itself.
CREATE FUNCTION search.verified_subject_page_v1(member bigint,lo integer,hi integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE original jsonb;
BEGIN
  SELECT p.cuts INTO STRICT original FROM semantic.subject_access_page_v1 p JOIN core.subject_retention_page_v1 c
    ON (c.birth,c.first_home,c.end_home)=(p.birth,p.first_home,p.end_home)
    WHERE (p.birth,p.first_home,p.end_home)=(member,lo,hi) AND p.captured_xid<>pg_current_xact_id();
  IF semantic.capture_subject_access_page_v1(member,lo,hi) IS DISTINCT FROM original THEN
    RAISE EXCEPTION 'Original Subject page changed' USING ERRCODE='40001'; END IF;
  RETURN original;
END $$;

-- Only the membership and original page start are inputs. The receiver resolves
-- the current registration, both committed producer pages, and each native head.
CREATE FUNCTION search.bind_subject_receiver_page_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m core.subject_subscription_v1; c search.public_filter_coverage_preparation;
  item jsonb; entry jsonb; previous text;
BEGIN
  SELECT * INTO STRICT m FROM core.subject_subscription_v1 WHERE birth=NEW.birth;
  SELECT c0.* INTO STRICT c FROM search.public_filter_registration r
    JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.subscription_protocol)=(0,m.bootstrap,1)
    JOIN search.public_filter_coverage_preparation c0 ON (c0.partition_no,c0.registration,c0.bootstrap)=(0,r.id,b.bootstrap)
    JOIN search.generation_publication j ON (j.partition_no,j.job,j.subscription_protocol)=(0,m.job,1)
    WHERE r.partition_no=0 AND r.state='active' AND c0.subscription_protocol=1 AND NOT c0.ack_retired
      AND c0.consumer=r.consumer AND r.physical_target=m.physical_target AND c0.definition=m.definition
      AND semantic.public_filter_native_json(r.consumer::jsonb)=m.consumer
      AND semantic.public_filter_native_json(b.consumer::jsonb)=m.consumer
      AND b.read_definition=c0.definition AND b.coverage_generation=c0.generation
      AND b.state='capturing' AND (b.coverage_after,b.account_after,b.coverage_root)=(c0.after_home,c0.after_home,c0.root)
      AND c0.after_home=NEW.first_home FOR UPDATE OF r,c0;
  SELECT end_home INTO STRICT NEW.end_home FROM core.subject_retention_page_v1
    WHERE (birth,first_home)=(NEW.birth,NEW.first_home);
  NEW.registration:=c.registration; NEW.bootstrap:=c.bootstrap;
  NEW.predecessor:=c.root; previous:=c.root; NEW.cuts:='[]'; NEW.adopted_by:=pg_current_xact_id();
  FOR item IN SELECT value FROM jsonb_array_elements(search.verified_subject_page_v1(m.birth,NEW.first_home,NEW.end_home))
  LOOP
    entry:=item-'account'-'claim'||jsonb_build_object('predecessor',previous);
    previous:=encode(sha256(convert_to(jsonb_build_array('subject-receiver/v1',m.birth,c.registration,c.generation,entry)::text,'UTF8')),'hex');
    NEW.cuts:=NEW.cuts||jsonb_build_array(entry||jsonb_build_object('root',previous));
  END LOOP;
  NEW.root:=previous;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_receiver_page_bind BEFORE INSERT ON search.subject_receiver_page_v1
  FOR EACH ROW EXECUTE FUNCTION search.bind_subject_receiver_page_v1();

-- The preparation guard checks the exact receiver page for this format.
ALTER FUNCTION search.public_filter_baseline_interval(integer,text,uuid,integer,integer,text,text)
  RENAME TO public_filter_legacy_baseline_interval;
CREATE FUNCTION search.public_filter_baseline_interval(owner_partition integer, registration_id text, bootstrap_id uuid,
  first_home integer, after_home integer, first_root text, final_root text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN c.subscription_protocol=1 THEN EXISTS (
    SELECT FROM core.subject_subscription_v1 s JOIN search.subject_receiver_page_v1 p ON p.birth=s.birth
    WHERE s.bootstrap=$3 AND (p.registration,p.bootstrap,p.first_home,p.end_home,p.predecessor,p.root)=($2,$3,$4,$5,$6,$7)
  ) ELSE search.public_filter_legacy_baseline_interval($1,$2,$3,$4,$5,$6,$7) END
  FROM search.public_filter_coverage_preparation c WHERE (c.partition_no,c.registration,c.bootstrap)=($1,$2,$3)
$$;

-- A receiver commit can outlive its reply. Source reads the committed page in
-- its next transaction under its own predecessor and seal guards.
CREATE FUNCTION search.adopt_subject_receiver_page_v1(member bigint, lo integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE p search.subject_receiver_page_v1;
BEGIN
  PERFORM FROM core.subject_subscription_v1 WHERE birth=member FOR UPDATE;
  SELECT * INTO p FROM search.subject_receiver_page_v1 WHERE (birth,first_home)=(member,lo);
  IF NOT FOUND THEN
    INSERT INTO search.subject_receiver_page_v1(birth,first_home) VALUES(member,lo) RETURNING * INTO p;
    UPDATE search.public_filter_coverage_preparation SET after_home=p.end_home,root=p.root
      WHERE (partition_no,registration,bootstrap,after_home,root)=(0,p.registration,p.bootstrap,lo,p.predecessor);
    IF NOT FOUND THEN RAISE EXCEPTION 'Stale Subject receiver prefix' USING ERRCODE='40001'; END IF;
  ELSE
    PERFORM search.verified_subject_page_v1(member,lo,p.end_home);
  END IF;
  RETURN p.end_home;
END $$;

DROP TRIGGER public_filter_bootstrap_baseline_seal ON semantic.public_filter_bootstrap;
CREATE TRIGGER public_filter_bootstrap_baseline_seal BEFORE UPDATE ON semantic.public_filter_bootstrap
  FOR EACH ROW WHEN (OLD.subscription_protocol=0) EXECUTE FUNCTION semantic.retain_public_filter_baseline_seal();
CREATE FUNCTION search.require_subject_receiver_prefix_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.coverage_generation IS NULL AND NEW.account_after=0 AND NEW.coverage_after=0 AND NOT NEW.coverage_sealed
    AND EXISTS (SELECT FROM search.public_filter_coverage_preparation c
      WHERE (c.partition_no,c.bootstrap,c.definition,c.generation,c.root,c.after_home,c.subscription_protocol)=
        (0,NEW.bootstrap,NEW.read_definition,NEW.coverage_generation,NEW.coverage_root,0,1)) THEN RETURN NEW; END IF;
  IF (NEW.coverage_after,NEW.coverage_root,NEW.coverage_sealed,NEW.account_after,NEW.coverage_generation)
    IS NOT DISTINCT FROM (OLD.coverage_after,OLD.coverage_root,OLD.coverage_sealed,OLD.account_after,OLD.coverage_generation)
    THEN RETURN NEW; END IF;
  IF OLD.coverage_sealed OR NEW.coverage_generation IS DISTINCT FROM OLD.coverage_generation
    OR NOT EXISTS (
      SELECT FROM core.subject_subscription_v1 s JOIN search.subject_receiver_page_v1 p USING(birth)
      JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,p.registration,p.bootstrap)
      WHERE (s.bootstrap,p.bootstrap,p.first_home,p.predecessor,p.end_home,p.root)=(OLD.bootstrap,NEW.bootstrap,
        OLD.coverage_after,OLD.coverage_root,NEW.coverage_after,NEW.coverage_root)
        AND p.adopted_by<>pg_current_xact_id() AND OLD.account_after=p.first_home AND NEW.account_after=p.end_home
        AND (c.after_home,c.root,c.definition,c.generation)=(p.end_home,p.root,NEW.read_definition,NEW.coverage_generation)
        AND NEW.coverage_sealed=(p.end_home=4096)
        AND search.verified_subject_page_v1(s.birth,p.first_home,p.end_home) IS NOT NULL) THEN
    RAISE EXCEPTION 'Source requires the committed original Subject receiver page' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_source_page_prefix BEFORE UPDATE ON semantic.public_filter_bootstrap
  FOR EACH ROW WHEN (OLD.subscription_protocol=1) EXECUTE FUNCTION search.require_subject_receiver_prefix_v1();

-- Resolve a single home in the original receiver format. All scans over dirty
-- homes use a separate birth-keyed index.
CREATE FUNCTION search.subject_receiver_cut_v1(original uuid, home integer)
RETURNS TABLE(birth bigint,registration text,cut jsonb) LANGUAGE sql STABLE ROWS 1 AS $$
  SELECT s.birth,p.registration,p.cuts->(home-p.first_home)
  FROM core.subject_subscription_v1 s JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced
    AND (d.registration_generation,d.restore_generation)=(s.registration_generation,s.restore_generation)
    AND d.store_identity=core.subject_retention_store_v1()
  JOIN core.publication_authority_epoch g ON (g.home_no,g.generation)=(0,s.registration_generation)
  JOIN dbos.workflow_writer_fence_domain restore ON restore.singleton AND restore.restore_generation=s.restore_generation
  CROSS JOIN LATERAL (SELECT p.* FROM search.subject_receiver_page_v1 p WHERE p.birth=s.birth AND p.first_home<=home
    ORDER BY p.first_home DESC LIMIT 1) p
  WHERE s.bootstrap=original AND p.bootstrap=original AND home<p.end_home
$$;
CREATE FUNCTION search.public_filter_original_home(owner integer, reg text, original uuid, home integer)
RETURNS SETOF search.public_filter_coverage_baseline LANGUAGE sql STABLE ROWS 1 AS $$
  SELECT b.* FROM search.public_filter_coverage_baseline b
    WHERE (b.partition_no,b.registration,b.bootstrap,b.source_home)=(owner,reg,original,home)
    AND NOT EXISTS (SELECT FROM core.subject_subscription_v1 s JOIN search.generation_publication j
      ON (j.partition_no,j.job,j.subscription_protocol)=(0,s.job,1) WHERE s.bootstrap=original)
  UNION ALL
  SELECT 0,reg,original,home,(p.cut->>'epoch')::integer,(p.cut->>'privacy')::bigint,(p.cut->>'command')::bigint,
    (p.cut->>'enqueue')::bigint,NULL::bigint,NULL::bigint,p.cut->>'receipt',p.cut->>'predecessor',p.cut->>'root'
    FROM search.subject_receiver_cut_v1(original,home) p WHERE owner=0 AND p.registration=reg
$$;

CREATE TABLE search.subject_receiver_dirty_v1 (
  birth bigint NOT NULL REFERENCES core.subject_subscription_v1,
  home integer NOT NULL CHECK (home BETWEEN 0 AND 4095),
  epoch integer NOT NULL CHECK (epoch>0),
  through_position bigint NOT NULL CHECK (through_position>0),
  change_generation bigint NOT NULL CHECK (change_generation>0),
  registration text COLLATE "C" NOT NULL,
  PRIMARY KEY (birth,home)
);
CREATE INDEX subject_receiver_changed_v1 ON search.subject_receiver_dirty_v1(registration,change_generation,home);
CREATE TRIGGER subject_receiver_dirty_monotone BEFORE UPDATE ON search.subject_receiver_dirty_v1
  FOR EACH ROW WHEN ((OLD.birth,OLD.home,OLD.epoch,OLD.registration) IS DISTINCT FROM (NEW.birth,NEW.home,NEW.epoch,NEW.registration)
    OR NEW.through_position<OLD.through_position OR NEW.change_generation<OLD.change_generation)
  EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER subject_receiver_dirty_original BEFORE DELETE ON search.subject_receiver_dirty_v1
  FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();
CREATE TRIGGER subject_receiver_dirty_truncate BEFORE TRUNCATE ON search.subject_receiver_dirty_v1
  FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();

-- Semantic validates the captured owner/key/interval and its stored privacy base
-- before insert. A receipt cannot commit unless Search records the obligation.
CREATE FUNCTION search.apply_subject_privacy_intake_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f semantic.subject_privacy_fanout_v1; reg text; revision bigint;
BEGIN
  SELECT * INTO STRICT f FROM semantic.subject_privacy_fanout_v1
    WHERE (partition_no,input_key,enqueue_revision)=(NEW.partition_no,NEW.input_key,NEW.enqueue_revision);
  SELECT r.id INTO STRICT reg FROM core.subject_subscription_v1 m
    CROSS JOIN LATERAL search.subject_receiver_cut_v1(m.bootstrap,f.partition_no) p
    JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(0,p.registration)
    JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,r.id,m.bootstrap)
    WHERE m.birth=NEW.birth AND r.state='active' AND r.physical_target=m.physical_target
      AND NOT c.ack_retired AND c.subscription_protocol=1
      AND (p.cut->>'epoch',p.cut->>'generation',(p.cut->>'privacy')::bigint)=
        (f.owner_epoch::text,f.home_generation::text,NEW.privacy_base) FOR UPDATE OF r;
  IF EXISTS (SELECT FROM search.subject_receiver_dirty_v1 WHERE (birth,home,epoch)=(NEW.birth,f.partition_no,f.owner_epoch)
      AND through_position>=f.through_position) THEN RETURN NEW; END IF;
  UPDATE search.public_filter_registration SET coverage_generation=coverage_generation+1
    WHERE (partition_no,id)=(0,reg) RETURNING coverage_generation INTO STRICT revision;
  INSERT INTO search.subject_receiver_dirty_v1 VALUES(NEW.birth,f.partition_no,f.owner_epoch,f.through_position,revision,reg)
    ON CONFLICT(birth,home) DO UPDATE SET through_position=excluded.through_position,change_generation=excluded.change_generation
      WHERE subject_receiver_dirty_v1.epoch=excluded.epoch AND subject_receiver_dirty_v1.through_position<excluded.through_position;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subject receiver home changed epoch' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_receiver_intake AFTER INSERT ON search.subject_privacy_intake_v1
  FOR EACH ROW EXECUTE FUNCTION search.apply_subject_privacy_intake_v1();

-- Called between native capture and disposition, on a separate checkout from
-- the Semantic home lock. A missing page leaves the captured interval live.
CREATE FUNCTION search.receive_subject_privacy_v1(wanted_home integer,wanted_key text,captured bigint,allowance integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE inserted integer;
BEGIN
  IF allowance IS NULL OR allowance NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid Subject intake limit'; END IF;
  WITH subscribers AS MATERIALIZED (
    SELECT f.*,k.birth,s.bootstrap FROM semantic.subject_privacy_fanout_v1 f
    CROSS JOIN LATERAL (SELECT k.birth FROM core.subject_subscription_key_v1 k
      WHERE k.input_key=f.input_key AND k.birth>f.after_birth AND k.birth<=f.membership_revision
      ORDER BY k.birth LIMIT allowance) k
    JOIN core.subject_subscription_v1 s ON s.birth=k.birth
    WHERE (f.partition_no,f.input_key,f.enqueue_revision)=(wanted_home,wanted_key,captured) AND NOT f.complete
  )
  INSERT INTO search.subject_privacy_intake_v1(birth,partition_no,input_key,enqueue_revision,privacy_base)
    SELECT s.birth,wanted_home,wanted_key,captured,(p.cut->>'privacy')::bigint FROM subscribers s
    CROSS JOIN LATERAL search.subject_receiver_cut_v1(s.bootstrap,wanted_home) p
    WHERE (p.cut->>'privacy')::bigint<s.through_position
    ORDER BY s.birth ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  RETURN inserted;
END $$;

CREATE FUNCTION search.shared_subject_job_v1(wanted uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT FROM search.generation_publication WHERE (partition_no,job,subscription_protocol)=(0,wanted,1))
$$;

-- Shared leaves independently project the previously verified creation windows
-- onto immutable receiver pages. The existing parent, terminal, physical
-- settlement and cross-transaction manifest guards consume the resulting root.
CREATE FUNCTION search.compare_subject_receiver_leaf_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a search.public_filter_ack_authority; previous search.public_filter_ack_range; homes integer; adjacent boolean;
BEGIN
  IF NEW.partition_no<>0 OR NEW.width NOT IN (1,2,4,8,16,32) OR NEW.first_home<0
    OR NEW.first_home+NEW.width>4096 OR NEW.first_home%NEW.width<>0 THEN
    RAISE EXCEPTION 'Invalid shared receiver interval' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL;
  NEW.registration:=a.registration; NEW.bootstrap:=a.bootstrap; NEW.revision:=gen_random_uuid();
  NEW.identity_digest:=a.identity_digest;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home/greatest(NEW.width,16)*greatest(NEW.width,16),greatest(NEW.width,16))
    ON CONFLICT DO NOTHING;
  NEW.witness:=search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,
    search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']));
  WITH member AS MATERIALIZED (
    SELECT m.birth,semantic.subject_access_definition_v1(m.birth) AS definition_digest
    FROM core.subject_subscription_v1 m WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap)
  ), compared AS (
    SELECT i.home,win.receipt,step.verified_root,win.through_pos,base.cut->>'predecessor' AS predecessor,
      base.cut->>'root' AS root,lag(base.cut->>'root') OVER (ORDER BY i.home) AS prior
    FROM member m CROSS JOIN generate_series(NEW.first_home,NEW.first_home+NEW.width-1) i(home)
    CROSS JOIN LATERAL (SELECT * FROM search.subject_receiver_page_v1 p
      WHERE p.birth=m.birth AND p.first_home<=i.home ORDER BY p.first_home DESC LIMIT 1) p
    JOIN semantic.subject_access_page_v1 ap ON (ap.birth,ap.first_home,ap.end_home,ap.definition_digest)=
      (p.birth,p.first_home,p.end_home,m.definition_digest)
    JOIN core.subject_retention_page_v1 cp ON (cp.birth,cp.first_home,cp.end_home)=(p.birth,p.first_home,p.end_home)
    CROSS JOIN LATERAL (SELECT p.cuts->(i.home-p.first_home) AS cut,ap.cuts->(i.home-p.first_home) AS src,
      cp.cuts->(i.home-p.first_home) AS original) base
    CROSS JOIN LATERAL (SELECT s.state,s.verified_root FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_home)=(0,a.bootstrap,a.execution,i.home)
        AND s.verified_binding=NEW.binding AND s.verified_root IS NOT NULL AND NOT s.complete LIMIT 1) step
    CROSS JOIN LATERAL search.public_filter_ack_window(step.state,i.home) win
    CROSS JOIN LATERAL core.subject_retention_heads_v1(i.home) h
    CROSS JOIN LATERAL semantic.subject_access_heads_v1(i.home,h.epoch) acc
    LEFT JOIN core.subject_cleanup_v1 permit ON permit.home=i.home
    WHERE (p.registration,p.bootstrap)=(a.registration,a.bootstrap) AND i.home<p.end_home
      AND base.src @> base.original AND base.cut-'root'-'predecessor'=base.src-'account'-'claim'
      AND (base.cut->>'home',base.cut->>'epoch',base.cut->>'generation')=(i.home::text,h.epoch::text,h.generation::text)
      AND (win.base,win.receipt,win.epoch)=((base.cut->>'command')::bigint,base.cut->>'receipt',h.epoch)
      AND h.command_base>=win.through_pos AND h.privacy_base>=(base.cut->>'privacy')::bigint
      AND acc.account_revision>=(base.src->>'account')::bigint AND acc.claim_revision>=(base.src->>'claim')::bigint
      AND (acc.enqueue_revision>(base.src->>'enqueue')::bigint OR (acc.enqueue_revision,acc.account_revision,acc.claim_revision)=
        ((base.src->>'enqueue')::bigint,(base.src->>'account')::bigint,(base.src->>'claim')::bigint))
      AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=(h.epoch,h.generation,h.restore)
        AND permit.command_through<=win.base AND permit.privacy_through<=(base.cut->>'privacy')::bigint))
      AND search.public_filter_ack_field(search.public_filter_ack_field(step.state::jsonb->1,'input'),'heldBirth')#>>'{}'=p.birth::text
  )
  SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
    max(predecessor) FILTER (WHERE home=NEW.first_home),max(root) FILTER (WHERE home=NEW.first_home+NEW.width-1),
    sha256(convert_to(jsonb_build_array('subject-receiver-leaf/v1',a.job,a.bootstrap,NEW.binding,a.identity_digest,
      jsonb_agg(to_jsonb(compared) ORDER BY home))::text,'UTF8'))
    INTO homes,adjacent,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM compared;
  IF homes<>NEW.width OR adjacent IS NOT TRUE THEN
    RAISE EXCEPTION 'Original shared receiver window unavailable' USING ERRCODE='40001'; END IF;
  SELECT * INTO previous FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND previous.digest IS DISTINCT FROM NEW.digest THEN
    RAISE EXCEPTION 'Conflicting shared receiver window replay' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER public_filter_ack_range_compare ON search.public_filter_ack_range;
CREATE TRIGGER public_filter_ack_range_compare BEFORE INSERT ON search.public_filter_ack_range FOR EACH ROW
  WHEN (NOT (search.shared_subject_job_v1(NEW.job) AND NEW.width<=32 AND NEW.left_child IS NULL AND NEW.right_child IS NULL))
  EXECUTE FUNCTION search.compare_public_filter_ack_range();
CREATE TRIGGER subject_receiver_leaf_compare BEFORE INSERT ON search.public_filter_ack_range FOR EACH ROW
  WHEN (search.shared_subject_job_v1(NEW.job) AND NEW.width<=32 AND NEW.left_child IS NULL AND NEW.right_child IS NULL)
  EXECUTE FUNCTION search.compare_subject_receiver_leaf_v1();

ALTER FUNCTION semantic.public_filter_effective_homes(text,uuid,integer,integer) RENAME TO public_filter_legacy_effective_homes;
CREATE FUNCTION semantic.public_filter_effective_homes(registration_id text, original uuid, point integer DEFAULT NULL,
  home_limit integer DEFAULT 9) RETURNS SETOF search.public_filter_coverage_home LANGUAGE plpgsql STABLE ROWS 9 AS $$
DECLARE m bigint; original_generation bigint; origin record; h search.public_filter_coverage_home; item record;
BEGIN
  IF home_limit IS NULL OR home_limit NOT BETWEEN 1 AND 9 OR point NOT BETWEEN 0 AND 4095 THEN
    RAISE EXCEPTION 'Invalid effective ACK home range' USING ERRCODE='22023'; END IF;
  SELECT s.birth,c.generation INTO m,original_generation FROM core.subject_subscription_v1 s
    LEFT JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,registration_id,original)
    WHERE s.bootstrap=original AND search.shared_subject_job_v1(s.job);
  IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM semantic.public_filter_legacy_effective_homes(registration_id,original,point,home_limit);
    RETURN;
  END IF;
  h.partition_no:=0; h.registration:=registration_id; h.source_home:=point; h.behind:=true;
  SELECT * INTO origin FROM semantic.public_filter_ack_origin(registration_id,original);
  IF NOT FOUND THEN RETURN NEXT h; RETURN; END IF;
  FOR item IN WITH wanted AS (
    (SELECT d.home FROM search.subject_receiver_dirty_v1 d WHERE point IS NULL AND d.birth=m ORDER BY home LIMIT home_limit)
    UNION ALL SELECT point WHERE point IS NOT NULL
  )
  SELECT w.home,b.cut,d.through_position,d.change_generation FROM wanted w
    LEFT JOIN LATERAL search.subject_receiver_cut_v1(original,w.home) b ON b.registration=registration_id
    LEFT JOIN search.subject_receiver_dirty_v1 d ON (d.birth,d.home)=(m,w.home)
    ORDER BY w.home
  LOOP
    h.source_home:=item.home; h.source_epoch:=(item.cut->>'epoch')::integer;
    h.baseline_bootstrap:=original; h.acknowledged_baseline:=CASE WHEN item.cut IS NOT NULL THEN original END;
    h.acknowledged_position:=(item.cut->>'privacy')::bigint;
    h.acknowledged_native_enqueue:=(item.cut->>'enqueue')::bigint; h.native_enqueue_revision:=h.acknowledged_native_enqueue;
    h.relevant_position:=coalesce(item.through_position,h.acknowledged_position);
    h.acknowledged_observation:=origin.observation; h.acknowledged_execution:=origin.execution;
    h.acknowledged_settlement:=origin.settlement; h.last_change_generation:=coalesce(item.change_generation,original_generation);
    h.behind:=item.cut IS NULL OR item.through_position IS NOT NULL; h.baseline_delta:=h.behind;
    RETURN NEXT h;
  END LOOP;
END $$;
-- A registration alone cannot identify which retained cut owns the ACK.
CREATE INDEX subject_receiver_live_registration_v1 ON search.public_filter_coverage_preparation(partition_no,registration)
  WHERE subscription_protocol=1 AND NOT ack_retired;
ALTER FUNCTION semantic.public_filter_book_dirty_homes(text) RENAME TO public_filter_legacy_book_dirty_homes;
CREATE FUNCTION semantic.public_filter_book_dirty_homes(registration_id text)
RETURNS SETOF search.public_filter_coverage_home LANGUAGE plpgsql STABLE ROWS 9 AS $$
BEGIN
  IF EXISTS (SELECT FROM search.public_filter_coverage_preparation c
      WHERE (c.partition_no,c.registration)=(0,registration_id) AND c.subscription_protocol=1 AND NOT c.ack_retired) THEN
    RAISE EXCEPTION 'A manifest ACK requires its original bootstrap' USING ERRCODE='40001';
  END IF;
  RETURN QUERY SELECT * FROM semantic.public_filter_legacy_book_dirty_homes(registration_id);
END $$;
CREATE FUNCTION search.public_filter_first_change_v1(reg text, since bigint)
RETURNS TABLE(source_home integer,source_epoch integer) LANGUAGE sql STABLE ROWS 1 AS $$
  (SELECT h.source_home,h.source_epoch FROM search.public_filter_coverage_home h WHERE
    (h.partition_no,h.registration)=(0,reg) AND h.last_change_generation>since ORDER BY last_change_generation,h.source_home LIMIT 1)
  UNION ALL
  (SELECT d.home,d.epoch FROM search.subject_receiver_dirty_v1 d
    WHERE d.registration=reg AND d.change_generation>since ORDER BY change_generation,home LIMIT 1)
  LIMIT 1
$$;

CREATE OR REPLACE VIEW search.public_filter_ack_authority AS
SELECT j.partition_no,j.job,j.phase,j.fence,j.fenced_pass,j.pass,j.physical_target,j.native_incarnation AS incarnation,
  o.registration,b.bootstrap,o.observation,x.id AS execution,b.read_definition,d.release_digest,p.epoch AS owner_epoch,
  c.generation,c.root AS enrollment_root,r.coverage_generation,x.repair_settlement,
  sha256(convert_to(jsonb_build_array(j.binding,j.consumer,b.consumer,b.source_position,b.owner_epoch,
    r.consumer,r.definition,o.queried,o.covered,o.prepared_build,o.prepared_generation,x.execution,
    d.source_id,d.configuration,d.capture_digest,d.release_digest,d.dependency_keys,d.coverage_keys)::text,'UTF8')) AS identity_digest
FROM search.generation_publication j
JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.publication_job)=(j.partition_no,j.job)
  AND b.publication_execution=j.job::text AND b.publication_observation=b.queried
  AND b.snapshot_kind='prepared' AND b.state='adopted' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(b.partition_no,b.queried)
  AND o.consumer_bootstrap='0:'||b.bootstrap::text AND o.prepared_build=o.consumer_bootstrap AND o.state='open'
JOIN search.public_filter_execution x ON (x.partition_no,x.observation,x.id)=(o.partition_no,o.observation,b.publication_execution)
JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
  AND r.state='active' AND r.physical_target=j.physical_target
JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=(r.partition_no,r.physical_target,j.native_incarnation)
JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(b.partition_no,b.read_definition)
  AND d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(d.partition_no,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=b.owner_epoch AND p.epoch=s.owner_epoch AND p.write_state='active'
JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(r.partition_no,r.id,b.bootstrap)
  AND c.ack_protocol=1 AND c.population_protocol=1 AND c.after_home=4096 AND c.definition=d.read_definition
  AND c.generation=b.coverage_generation AND c.root=b.coverage_root AND c.consumer=r.consumer
WHERE j.partition_no=0 AND j.source_home=0 AND j.family='subjects' AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND (j.observation IS NULL OR j.observation=o.observation)
  AND (j.bootstrap IS NULL OR (j.bootstrap,j.queried,j.execution)=(o.consumer_bootstrap,o.queried,x.id))
  AND (c.subscription_protocol=0 OR (j.subscription_protocol=1 AND b.subscription_protocol=1 AND EXISTS (
    SELECT FROM core.subject_subscription_v1 m JOIN core.subject_retention_domain shared ON shared.singleton AND NOT shared.fenced
      AND (m.registration_generation,m.restore_generation)=(shared.registration_generation,shared.restore_generation)
    JOIN core.publication_authority_epoch owner ON owner.home_no=0 AND owner.generation=m.registration_generation
    JOIN dbos.workflow_writer_fence_domain restore ON restore.singleton AND restore.restore_generation=m.restore_generation
    WHERE (m.job,m.bootstrap,m.definition,m.physical_target,m.incarnation,m.consumer,m.generation)=
      (j.job,b.bootstrap,d.read_definition,j.physical_target,j.native_incarnation,j.consumer,j.generation)
      AND shared.store_identity=core.subject_retention_store_v1()
  )));

CREATE OR REPLACE FUNCTION semantic.public_filter_published_coverage(physical_target text, incarnation text, child_definition uuid, publication_job uuid, text_keys text[]) RETURNS TABLE(job uuid, bootstrap uuid, registration text, definition uuid, consumer text, generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[])
    LANGUAGE sql STABLE
    AS $_$
WITH candidates AS MATERIALIZED (
  SELECT j.* FROM search.generation_publication j
  WHERE j.partition_no=0 AND j.physical_target=$1 AND j.native_incarnation=$2
    AND j.family='subjects' AND j.phase='active' AND j.fence IS NULL
    AND ($4 IS NULL OR j.job=$4)
  LIMIT 2
)
SELECT j.job,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM candidates j
-- Resolve every immutable publication reference by its unique native key.
-- A physical target, release or partition can host many other registrations and cuts.
JOIN LATERAL (
  SELECT b.* FROM semantic.public_filter_bootstrap b WHERE (b.partition_no,b.publication_job)=(0,j.job) LIMIT 1
) b ON j.bootstrap='0:'||b.bootstrap::text AND j.observation=b.publication_observation
  AND j.execution=b.publication_execution AND b.queried=j.observation AND b.state='adopted'
  AND b.snapshot_kind='prepared' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN LATERAL (
  SELECT seal.step,seal.complete,seal.ack_after FROM semantic.public_filter_repair_step seal
  WHERE (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,b.publication_execution)
    AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL LIMIT 1
) seal ON seal.complete AND seal.ack_after=4096
JOIN LATERAL (
  SELECT o.* FROM search.public_filter_observation o WHERE (o.partition_no,o.observation)=(0,j.observation) LIMIT 1
) o ON o.consumer_bootstrap=j.bootstrap AND o.prepared_build=j.bootstrap AND o.state='open'
  AND o.expires_at>extract(epoch FROM statement_timestamp())*1000
JOIN LATERAL (
  SELECT r.* FROM search.public_filter_registration r WHERE (r.partition_no,r.id)=(0,o.registration) LIMIT 1
) r ON r.physical_target=j.physical_target AND r.state='active'
JOIN LATERAL (
  SELECT t.incarnation FROM search.public_filter_target t WHERE (t.partition_no,t.physical_target)=(0,r.physical_target) LIMIT 1
) t ON t.incarnation=j.native_incarnation
JOIN LATERAL (
  SELECT d.* FROM semantic.public_filter_read_definition d WHERE (d.partition_no,d.read_definition)=(0,b.read_definition) LIMIT 1
) d ON d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN LATERAL (
  SELECT child.* FROM semantic.public_filter_read_definition child WHERE (child.partition_no,child.read_definition)=(0,$3) LIMIT 1
) child ON (child.source_id,child.configuration,child.release_digest)=(d.source_id,d.configuration,d.release_digest)
  AND child.coverage_keys IS NOT NULL
CROSS JOIN LATERAL (
  SELECT s.owner_epoch FROM semantic.public_filter_source s
  WHERE (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration) LIMIT 1
) s
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN LATERAL (
  SELECT c.* FROM search.public_filter_coverage_preparation c
  WHERE (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap) LIMIT 1
) c ON c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN LATERAL (
  SELECT last_home.root FROM search.public_filter_original_home(0,r.id,b.bootstrap,4095) last_home LIMIT 1
) last_home ON last_home.root=c.root
WHERE (SELECT count(*) FROM candidates)=1
  AND (c.ack_protocol=0 OR EXISTS (
    SELECT FROM semantic.public_filter_ack_origin(r.id,b.bootstrap) m
    WHERE (m.job,m.observation,m.execution,m.terminal,m.ack_after)=(j.job,j.observation,j.execution,seal.step,4096)
  ))
  AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND child.coverage_keys <@ (d.coverage_keys || $5)
$_$;


-- Called by the publication worker after it reopens the pinned job. Search
-- commits its receiver page before Source can move its own cursor.
CREATE FUNCTION search.begin_subject_receiver_v1(job_id uuid, encoded_consumer text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE state record; initial_root text;
BEGIN
  SELECT m.birth,m.bootstrap,m.definition,r.id,r.coverage_generation,b.coverage_generation AS pinned INTO state
    FROM core.subject_subscription_v1 m
    JOIN search.generation_publication j ON (j.partition_no,j.job,j.subscription_protocol)=(0,m.job,1)
    JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=(0,m.physical_target,m.incarnation)
    JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.read_definition,b.subscription_protocol)=
      (0,m.bootstrap,m.definition,1)
    JOIN semantic.subject_source_preparation_v1 src ON (src.birth,src.bootstrap)=(m.birth,b.bootstrap)
    JOIN search.public_filter_registration r ON (r.partition_no,r.physical_target,r.state)=(0,t.physical_target,'active')
      AND md5(r.consumer)=md5(encoded_consumer) AND r.consumer=encoded_consumer
    WHERE m.job=job_id AND b.snapshot_kind='prepared' AND semantic.public_filter_native_json(r.consumer::jsonb)=m.consumer
      AND (j.consumer,j.native_incarnation,j.generation)=(m.consumer,m.incarnation,m.generation)
    FOR UPDATE OF r,b;
  IF NOT FOUND THEN RETURN false; END IF;
  IF state.pinned IS NOT NULL THEN RETURN EXISTS (
    SELECT FROM search.public_filter_coverage_preparation WHERE (partition_no,registration,bootstrap,subscription_protocol)=
      (0,state.id,state.bootstrap,1)); END IF;
  initial_root:=encode(sha256(convert_to(jsonb_build_array('subject-receiver/v1',state.birth,state.id,
    state.definition,state.coverage_generation,encoded_consumer)::text,'UTF8')),'hex');
  INSERT INTO search.public_filter_coverage_preparation
    (partition_no,registration,bootstrap,definition,consumer,generation,root,population_protocol,ack_protocol,subscription_protocol)
    VALUES(0,state.id,state.bootstrap,state.definition,encoded_consumer,state.coverage_generation,initial_root,1,1,1);
  UPDATE semantic.public_filter_bootstrap SET coverage_generation=state.coverage_generation,coverage_root=initial_root
    WHERE (partition_no,bootstrap,semantic.public_filter_bootstrap.state)=(0,state.bootstrap,'capturing') AND coverage_generation IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subject receiver preparation changed' USING ERRCODE='40001'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION search.advance_subject_receiver_v1(job_id uuid,max_homes integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE state record;
BEGIN
  SELECT s.birth,p.first_home,p.end_home,b.coverage_after INTO state FROM core.subject_subscription_v1 s
    JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.subscription_protocol)=(0,s.bootstrap,1)
    JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home)=(s.birth,b.coverage_after)
    WHERE s.job=job_id AND b.state='capturing' AND b.coverage_generation IS NOT NULL;
  IF NOT FOUND OR max_homes IS NULL OR state.end_home-state.first_home>max_homes THEN RETURN 0; END IF;
  RETURN search.adopt_subject_receiver_page_v1(state.birth,state.first_home)-state.first_home;
END $$;
CREATE FUNCTION semantic.accept_subject_receiver_page_v1(job_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE accepted integer;
BEGIN
  UPDATE semantic.public_filter_bootstrap b SET account_after=p.end_home,coverage_after=p.end_home,
    coverage_root=p.root,coverage_sealed=(p.end_home=4096),state=CASE WHEN p.end_home=4096 THEN 'begun' ELSE 'capturing' END
    FROM core.subject_subscription_v1 s JOIN search.subject_receiver_page_v1 p USING(birth)
    WHERE s.job=job_id AND (b.partition_no,b.bootstrap,b.coverage_after,b.coverage_root)=(0,s.bootstrap,p.first_home,p.predecessor)
      AND b.subscription_protocol=1 AND b.state='capturing' AND p.adopted_by<>pg_current_xact_id()
    RETURNING p.end_home-p.first_home INTO accepted;
  RETURN coalesce(accepted,0);
END $$;

-- The first independent engine traversal uses the original command bases. A
-- home that advanced still owes its ordinary writer/engine verification.
CREATE FUNCTION search.subject_original_physical_homes_v1(job_id uuid,lo integer,hi integer)
RETURNS TABLE(home integer,epoch integer,command_base bigint) LANGUAGE sql STABLE AS $$
  WITH member AS MATERIALIZED (
    SELECT m.birth FROM core.subject_subscription_v1 m
    JOIN semantic.subject_source_preparation_v1 s ON (s.birth,s.bootstrap,s.next_home)=(m.birth,m.bootstrap,4096)
    JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.subscription_protocol)=(0,m.bootstrap,1)
    JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced AND d.store_identity=core.subject_retention_store_v1()
      AND (m.registration_generation,m.restore_generation)=(d.registration_generation,d.restore_generation)
    WHERE m.job=job_id AND EXISTS (SELECT FROM core.subject_retention_heads_v1(0) h WHERE h.restore=m.restore_generation)
      AND b.coverage_sealed AND lo>=0 AND hi<=4096 AND hi-lo BETWEEN 1 AND 1000
  ), pages AS (
    (SELECT p.* FROM member m JOIN search.subject_receiver_page_v1 p USING(birth)
      WHERE p.first_home<=lo ORDER BY first_home DESC LIMIT 1)
    UNION ALL SELECT p.* FROM member m JOIN search.subject_receiver_page_v1 p USING(birth)
      WHERE p.first_home>lo AND p.first_home<hi
  )
  SELECT n,(p.cuts->(n-p.first_home)->>'epoch')::integer,(p.cuts->(n-p.first_home)->>'command')::bigint
  FROM pages p CROSS JOIN LATERAL generate_series(greatest(lo,p.first_home),least(hi,p.end_home)-1) n
$$;

ALTER TABLE search.subject_receiver_page_v1 ENABLE ALWAYS TRIGGER subject_receiver_page_bind;
ALTER TABLE search.subject_receiver_page_v1 ENABLE ALWAYS TRIGGER subject_receiver_page_original;
ALTER TABLE search.subject_receiver_page_v1 ENABLE ALWAYS TRIGGER subject_receiver_page_truncate;
ALTER TABLE search.subject_receiver_dirty_v1 ENABLE ALWAYS TRIGGER subject_receiver_dirty_monotone;
ALTER TABLE search.subject_receiver_dirty_v1 ENABLE ALWAYS TRIGGER subject_receiver_dirty_original;
ALTER TABLE search.subject_receiver_dirty_v1 ENABLE ALWAYS TRIGGER subject_receiver_dirty_truncate;
ALTER TABLE search.subject_privacy_intake_v1 ENABLE ALWAYS TRIGGER subject_receiver_intake;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject receiver pages require forward migration'; END $$;
