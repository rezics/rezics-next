--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: search; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA search;


--
-- Name: public_filter_ack_basis_v1; Type: TYPE; Schema: search; Owner: -
--

CREATE TYPE search.public_filter_ack_basis_v1 AS (
	authority bytea,
	pages bytea
);


--
-- Name: adopt_subject_receiver_page_v1(bigint, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.adopt_subject_receiver_page_v1(member bigint, lo integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: advance_public_filter_coverage_preparation(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.advance_public_filter_coverage_preparation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.partition_no,NEW.registration,NEW.bootstrap,NEW.definition,NEW.consumer,NEW.generation)
     IS DISTINCT FROM
     (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.definition,OLD.consumer,OLD.generation)
  THEN
    RAISE EXCEPTION 'Original coverage preparation binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.after_home,NEW.root) IS DISTINCT FROM (OLD.after_home,OLD.root)
    AND NOT search.public_filter_baseline_interval(
      OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.after_home,NEW.after_home,OLD.root,NEW.root)
  THEN
    RAISE EXCEPTION 'Coverage preparation requires its original contiguous receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: advance_public_filter_repair_authority(text, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.advance_public_filter_repair_authority(target text, home integer) RETURNS void
    LANGUAGE sql
    AS $$
  INSERT INTO search.public_filter_repair_authority AS a(physical_target,lane,revision) VALUES (target,home%4,1)
  ON CONFLICT (physical_target,lane) DO UPDATE SET revision=a.revision+1
$$;


--
-- Name: advance_subject_receiver_v1(uuid, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.advance_subject_receiver_v1(job_id uuid, max_homes integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE state record;
BEGIN
  SELECT s.birth,p.first_home,p.end_home,b.coverage_after INTO state FROM core.subject_subscription_v1 s
    JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.subscription_protocol)=(0,s.bootstrap,1)
    JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home)=(s.birth,b.coverage_after)
    WHERE s.job=job_id AND b.state='capturing' AND b.coverage_generation IS NOT NULL;
  IF NOT FOUND OR max_homes IS NULL OR state.end_home-state.first_home>max_homes THEN RETURN 0; END IF;
  RETURN search.adopt_subject_receiver_page_v1(state.birth,state.first_home)-state.first_home;
END $$;


--
-- Name: apply_subject_privacy_intake_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.apply_subject_privacy_intake_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: begin_public_filter_ack_clock(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.begin_public_filter_ack_clock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(NEW.partition_no,NEW.registration,NEW.bootstrap,0,4096);
  RETURN NULL;
END $$;


--
-- Name: begin_subject_receiver_v1(uuid, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.begin_subject_receiver_v1(job_id uuid, encoded_consumer text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: bind_public_filter_ack_manifest(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.bind_public_filter_ack_manifest() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  t semantic.public_filter_repair_step%ROWTYPE;
  root search.public_filter_ack_range%ROWTYPE;
  state jsonb;
  proof jsonb;
  last_page jsonb;
  pages integer;
  current_cut bytea;
BEGIN
  -- Same short lock order as explicit ACK and receiver fanout.
  PERFORM FROM core.partition WHERE partition_no=0 AND write_state='active' FOR SHARE;
  PERFORM FROM search.public_filter_target target JOIN search.generation_publication j
    ON (target.partition_no,target.physical_target,target.incarnation)=(j.partition_no,j.physical_target,j.native_incarnation)
    WHERE (j.partition_no,j.job)=(0,NEW.job) FOR SHARE OF target,j;
  PERFORM FROM search.public_filter_registration r JOIN search.public_filter_ack_authority v
    ON (r.partition_no,r.id)=(v.partition_no,v.registration) WHERE v.job=NEW.job FOR UPDATE OF r;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL FOR SHARE;
  SELECT * INTO STRICT t FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.complete
      AND s.verified_binding IS NOT NULL AND s.verified_root IS NOT NULL AND s.verified_next IS NULL AND s.ack_after=0 FOR SHARE;
  current_cut := search.public_filter_ack_range_witness(a.bootstrap,0,4096,
    search.public_filter_ack_basis_v1(search.shared_subject_job_v1(a.job)));
  SELECT * INTO STRICT root FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,t.verified_binding,0,4096,current_cut)
      AND registration=a.registration AND bootstrap=a.bootstrap AND enrollment_root=a.enrollment_root AND identity_digest=a.identity_digest;
  state := a.repair_settlement::jsonb->1;
  pages := search.public_filter_ack_field(state,'pages')::integer;
  SELECT v.progress::jsonb->1,v.evidence_revision INTO STRICT proof,NEW.evidence_revision FROM search.public_filter_repair_verification v
    WHERE (v.partition_no,v.observation,v.execution)=(0,a.observation,a.execution) FOR SHARE;
  SELECT CASE WHEN page.intent::jsonb->>0='references' THEN page.intent::jsonb#>'{1,1,1}' ELSE page.intent::jsonb->1 END
    INTO STRICT last_page FROM search.public_filter_repair_page page
    WHERE (page.partition_no,page.observation,page.execution,page.ordinal)=(0,a.observation,a.execution,pages-1) FOR SHARE;
  IF (search.public_filter_ack_field(state,'closed')='true' AND search.public_filter_ack_field(state,'frontier')='null'
    AND search.public_filter_ack_field(state,'bootstrap')#>>'{}'='0:'||a.bootstrap::text
    AND search.public_filter_ack_field(state,'execution')#>>'{}'=a.execution
    AND search.public_filter_ack_field(search.public_filter_ack_field(state,'fence'),'transaction')#>>'{}'=pg_current_xact_id()::text
    AND search.public_filter_ack_field(search.public_filter_ack_field(state,'fence'),'incarnation')#>>'{}'=a.incarnation
    AND search.public_filter_ack_field(search.public_filter_ack_field(state,'fence'),'sourceEpoch')::integer=a.owner_epoch
    AND search.public_filter_ack_field(proof,'after')::integer=pages-1 AND search.public_filter_ack_field(proof,'linked')::integer=pages-1
    AND search.public_filter_ack_field(search.public_filter_ack_field(proof,'winners'),'done')='true'
    AND search.public_filter_ack_field(last_page,'sourceStep')#>>'{}'=t.step::text
    AND search.public_filter_ack_field(last_page,'complete')='true') IS NOT TRUE THEN
    RAISE EXCEPTION 'Receiver manifest requires the original fenced terminal settlement' USING ERRCODE='40001';
  END IF;
  NEW.partition_no := 0; NEW.registration := a.registration; NEW.bootstrap := a.bootstrap;
  NEW.version := 1; NEW.root_revision := root.revision; NEW.root_digest := root.digest;
  NEW.generation := a.generation; NEW.enrollment_root := a.enrollment_root; NEW.owner_epoch := a.owner_epoch;
  NEW.physical_target := a.physical_target; NEW.incarnation := a.incarnation;
  NEW.observation := a.observation; NEW.execution := a.execution; NEW.terminal := t.step;
  NEW.binding := t.verified_binding; NEW.ordinal := t.verified_ordinal; NEW.terminal_root := t.verified_root;
  NEW.settlement := search.public_filter_ack_field(state,'id')#>>'{}';
  NEW.settlement_digest := search.public_filter_ack_settlement_digest(state);
  NEW.identity_digest := a.identity_digest;
  NEW.continuity := (SELECT sha256(uuid_send(clock.incarnation)||int8send(clock.continuity)||
        search.public_filter_ack_witness(ARRAY['','@ack-retention'])) FROM search.public_filter_ack_home_clock clock
        WHERE (clock.bootstrap,clock.first_home,clock.width)=(a.bootstrap,0,4096) FOR SHARE OF clock);
  NEW.committed_by := pg_current_xact_id();
  RETURN NEW;
END $$;


--
-- Name: bind_subject_receiver_page_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.bind_subject_receiver_page_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: capture_freshness_position(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.capture_freshness_position() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_consumer text := '';
  new_consumer text := '';
  emptied boolean;
BEGIN
  IF TG_TABLE_NAME = 'consumer_checkpoint' THEN
    old_consumer := OLD.consumer;
    new_consumer := NEW.consumer;
    IF NOT (coalesce(starts_with(old_consumer, 'search_'), false)
         OR coalesce(starts_with(new_consumer, 'search_'), false)) THEN RETURN NULL; END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (old_consumer, OLD.partition_no, OLD.position)
      IS NOT DISTINCT FROM (new_consumer, NEW.partition_no, NEW.position) THEN RETURN NULL; END IF;

  IF TG_OP <> 'INSERT' AND OLD.position > 0 AND (old_consumer = '' OR starts_with(old_consumer, 'search_'))
      AND (TG_OP = 'DELETE' OR NEW.position = 0
           OR (old_consumer, OLD.partition_no) IS DISTINCT FROM (new_consumer, NEW.partition_no)) THEN
    UPDATE search.freshness_positions SET positions = positions - OLD.partition_no::text
      WHERE consumer = old_consumer AND shard = OLD.partition_no / 64
      RETURNING positions = '{}'::jsonb INTO emptied;
    IF emptied THEN
      DELETE FROM search.freshness_positions WHERE consumer = old_consumer AND shard = OLD.partition_no / 64;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.position > 0 AND (new_consumer = '' OR starts_with(new_consumer, 'search_')) THEN
    INSERT INTO search.freshness_positions AS retained (consumer, shard, positions)
      VALUES (new_consumer, NEW.partition_no / 64, jsonb_build_object(NEW.partition_no, NEW.position))
      ON CONFLICT (consumer, shard) DO UPDATE SET positions = retained.positions || EXCLUDED.positions;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: change_subject_ack_stamp_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.change_subject_ack_stamp_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_home integer; new_home integer; home integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE search.public_filter_repair_authority SET revision=revision+1,
      subject_pages=decode(repeat(replace(gen_random_uuid()::text,'-',''),32),'hex') WHERE physical_target='@source';
  ELSE
    IF TG_OP<>'INSERT' THEN old_home:=OLD.first_home; END IF;
    IF TG_OP<>'DELETE' THEN new_home:=NEW.first_home; END IF;
    FOR home IN SELECT DISTINCT h FROM unnest(ARRAY[old_home,new_home]) h WHERE h IS NOT NULL ORDER BY h LOOP
      UPDATE search.public_filter_repair_authority SET revision=revision+1,
        subject_pages=overlay(subject_pages placing uuid_send(gen_random_uuid()) from 1+16*((home/32)%32) for 16)
        WHERE (physical_target,lane)=('@source',home/1024);
      IF NOT FOUND THEN RAISE EXCEPTION 'Missing Subject ACK page clock' USING ERRCODE='40001'; END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: classify_public_filter_ack_home(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.classify_public_filter_ack_home() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b search.public_filter_coverage_baseline%ROWTYPE;
BEGIN
  -- A NULL marker has no staged comparison. Leave v0 and unvisited v1
  -- homes out of the delta index; a full manifest requires every marker.
  IF TG_OP='INSERT' THEN NEW.baseline_delta := NULL; RETURN NEW; END IF;
  IF OLD.baseline_delta IS NOT NULL THEN
    IF TG_OP='DELETE' OR
      (NEW.partition_no,NEW.registration,NEW.source_home,NEW.source_epoch,NEW.baseline_bootstrap) IS DISTINCT FROM
      (OLD.partition_no,OLD.registration,OLD.source_home,OLD.source_epoch,OLD.baseline_bootstrap) THEN
      PERFORM search.lose_public_filter_ack_cut(OLD.baseline_bootstrap);
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      NEW.baseline_delta := NULL;
      RETURN NEW;
    END IF;
    IF (NEW.relevant_position,NEW.native_enqueue_revision,NEW.native_revision,NEW.native_claim_revision,
      NEW.acknowledged_position,NEW.acknowledged_native_enqueue,NEW.acknowledged_baseline,NEW.acknowledged_settlement,
      NEW.acknowledged_native_revision,NEW.acknowledged_native_claim_revision,NEW.last_change_generation)
      IS DISTINCT FROM (OLD.relevant_position,OLD.native_enqueue_revision,OLD.native_revision,OLD.native_claim_revision,
      OLD.acknowledged_position,OLD.acknowledged_native_enqueue,OLD.acknowledged_baseline,OLD.acknowledged_settlement,
      OLD.acknowledged_native_revision,OLD.acknowledged_native_claim_revision,OLD.last_change_generation) THEN
      INSERT INTO search.public_filter_ack_home_clock AS h(partition_no,registration,bootstrap,first_home,width,revision)
        SELECT 0,OLD.registration,OLD.baseline_bootstrap,OLD.source_home/span*span,span,1
        FROM unnest(ARRAY[4096,2048,1024,512,256,128,64,32,16]) span ORDER BY span DESC
        ON CONFLICT (bootstrap,first_home,width) DO UPDATE SET revision=h.revision+1;
    END IF;
  ELSIF TG_OP='DELETE' THEN RETURN OLD;
  ELSIF NEW.baseline_delta IS NULL THEN RETURN NEW;
  END IF;
  SELECT base.* INTO b FROM search.public_filter_coverage_preparation c
    JOIN search.public_filter_coverage_baseline base USING(partition_no,registration,bootstrap)
    WHERE (c.partition_no,c.registration,c.bootstrap)=(NEW.partition_no,NEW.registration,NEW.baseline_bootstrap)
      AND c.ack_protocol=1 AND base.source_home=NEW.source_home AND base.source_epoch=NEW.source_epoch;
  IF NOT FOUND THEN NEW.baseline_delta := NULL; RETURN NEW; END IF;
  NEW.baseline_delta := NEW.relevant_position>b.source_position
    OR NEW.native_enqueue_revision>b.native_enqueue_revision
    OR NEW.native_revision IS DISTINCT FROM b.native_revision
    OR NEW.native_claim_revision IS DISTINCT FROM b.native_claim_revision;
  RETURN NEW;
END $$;


--
-- Name: clear_settled_relay_intent(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.clear_settled_relay_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Previous writers consume the retained bulk receipt without naming the intent column.
  NEW.relay_intent := NULL;
  RETURN NEW;
END
$$;


--
-- Name: compare_public_filter_ack_range(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.compare_public_filter_ack_range() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  l search.public_filter_ack_range%ROWTYPE;
  r search.public_filter_ack_range%ROWTYPE;
  homes integer;
  chain_ok boolean;
  foreign_cut search.public_filter_ack_basis_v1;
  child_cut bytea;
  previous_node search.public_filter_ack_range%ROWTYPE;
BEGIN
  IF NEW.partition_no<>0 OR NEW.first_home NOT BETWEEN 0 AND 4095 OR NEW.width NOT IN
    (1,2,4,8,16,32,64,128,256,512,1024,2048,4096) OR NEW.first_home%NEW.width<>0 THEN
    RAISE EXCEPTION 'Invalid receiver interval' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL;
  NEW.registration := a.registration;
  NEW.bootstrap := a.bootstrap;
  NEW.revision := gen_random_uuid();
  NEW.identity_digest := a.identity_digest;
  IF NEW.width<=32 AND NEW.left_child IS NULL AND NEW.right_child IS NULL THEN
    UPDATE search.public_filter_coverage_home h SET baseline_delta=true
    WHERE (h.partition_no,h.registration,h.baseline_bootstrap)=(0,a.registration,a.bootstrap)
      AND h.source_home>=NEW.first_home AND h.source_home<NEW.first_home+NEW.width AND h.baseline_delta IS NULL;
  END IF;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home/greatest(NEW.width,16)*greatest(NEW.width,16),greatest(NEW.width,16))
    ON CONFLICT DO NOTHING;
  foreign_cut := search.public_filter_ack_basis_v1(search.shared_subject_job_v1(a.job));
  NEW.witness := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,foreign_cut);
  IF NEW.width<=32 AND NEW.left_child IS NULL AND NEW.right_child IS NULL THEN
    WITH steps AS MATERIALIZED (
      (SELECT s.step,s.state,s.verified_root,s.verified_ordinal,s.verified_home
       FROM semantic.public_filter_repair_step s
       WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_binding=NEW.binding
         AND s.verified_home<=NEW.first_home AND s.verified_root IS NOT NULL AND NOT s.complete
       ORDER BY s.verified_home DESC LIMIT 1)
      UNION ALL
      SELECT s.step,s.state,s.verified_root,s.verified_ordinal,s.verified_home FROM semantic.public_filter_repair_step s
       WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_binding=NEW.binding
         AND s.verified_home>NEW.first_home AND s.verified_home<NEW.first_home+NEW.width
         AND s.verified_root IS NOT NULL AND NOT s.complete
    ), windows AS (
      SELECT steps.*,lead(verified_home,1,NEW.first_home+NEW.width) OVER (ORDER BY verified_home) AS end_home FROM steps
    ), members AS MATERIALIZED (
      SELECT i.home,w.step,w.verified_root,w.verified_ordinal,win.through_pos,b.predecessor,b.root,
        b.receipt,b.creation_position,b.source_epoch,b.source_position,b.native_enqueue_revision,
        b.native_revision,b.native_claim_revision,h.acknowledged_position,h.acknowledged_native_enqueue,
        h.relevant_position,h.native_enqueue_revision AS current_enqueue,h.native_revision AS current_revision,
        h.native_claim_revision AS current_claim,h.last_change_generation,h.baseline_delta,
        ph.position AS privacy_position,ac.revision AS account_revision,ac.claim_revision AS account_claim
      FROM windows w
      CROSS JOIN LATERAL generate_series(greatest(w.verified_home,NEW.first_home),w.end_home-1) i(home)
      CROSS JOIN LATERAL search.public_filter_ack_window(w.state,i.home) win
      JOIN semantic.public_filter_home_enrollment e ON (e.partition_no,e.bootstrap)=(i.home,a.bootstrap)
        AND e.complete AND e.registration_partition=0 AND e.registration=a.registration AND e.read_definition=a.read_definition
        AND (e.owner_epoch,e.receipt,e.creation_position)=(win.epoch,win.receipt,win.base)
        AND e.creation_consumer='public_filter_'||replace(a.bootstrap::text,'-','')
      JOIN core.partition p ON p.partition_no=i.home AND p.epoch=e.owner_epoch AND p.write_state='active' AND p.position>=win.through_pos
      JOIN core.consumer_checkpoint ck ON (ck.partition_no,ck.consumer)=(i.home,e.creation_consumer)
        AND ck.position<=win.base AND (ck.epoch IS NULL OR ck.epoch=p.epoch)
      JOIN semantic.public_filter_privacy_head ph ON ph.partition_no=i.home AND ph.owner_epoch=p.epoch AND ph.position>=e.source_position
      JOIN access.account_discovery_population ac ON ac.partition_no=i.home
      JOIN search.public_filter_coverage_baseline b ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=(0,a.registration,a.bootstrap,i.home)
        AND (b.source_epoch,b.receipt,b.creation_position,b.source_position,b.native_enqueue_revision)=
            (e.owner_epoch,e.receipt,e.creation_position,e.source_position,e.native_enqueue_revision)
        AND b.native_revision IS NOT DISTINCT FROM e.native_revision AND b.native_claim_revision IS NOT DISTINCT FROM e.native_claim_revision
      JOIN search.public_filter_coverage_home h ON (h.partition_no,h.registration,h.source_home)=(0,a.registration,i.home)
        AND h.source_epoch=e.owner_epoch AND h.baseline_bootstrap=e.bootstrap
        AND h.acknowledged_position<=b.source_position AND h.acknowledged_native_enqueue<=b.native_enqueue_revision
      WHERE e.partition_no>=NEW.first_home AND e.partition_no<NEW.first_home+NEW.width
        AND b.source_home>=NEW.first_home AND b.source_home<NEW.first_home+NEW.width
        AND h.source_home>=NEW.first_home AND h.source_home<NEW.first_home+NEW.width
        AND h.baseline_delta=(h.relevant_position>b.source_position OR h.native_enqueue_revision>b.native_enqueue_revision
        OR h.native_revision IS DISTINCT FROM b.native_revision OR h.native_claim_revision IS DISTINCT FROM b.native_claim_revision)
    ), ordered AS (
      SELECT m.*,lag(root) OVER (ORDER BY home) AS prior FROM members m
    )
    SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
      max(predecessor) FILTER (WHERE home=NEW.first_home),max(root) FILTER (WHERE home=NEW.first_home+NEW.width-1),
      sha256(convert_to(jsonb_agg(to_jsonb(ordered) ORDER BY home)::text,'UTF8'))
    INTO homes,chain_ok,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM ordered;
    IF homes<>NEW.width OR chain_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'Original receiver home evidence unavailable' USING ERRCODE='40001';
    END IF;
  ELSE
    child_cut := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width/2,foreign_cut);
    SELECT * INTO STRICT l FROM search.public_filter_ack_range
      WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width/2,child_cut);
    child_cut := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home+NEW.width/2,NEW.width/2,foreign_cut);
    SELECT * INTO STRICT r FROM search.public_filter_ack_range
      WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home+NEW.width/2,NEW.width/2,child_cut);
    IF (l.registration,l.bootstrap,l.enrollment_root) IS DISTINCT FROM (a.registration,a.bootstrap,r.predecessor)
      OR (r.registration,r.bootstrap) IS DISTINCT FROM (a.registration,a.bootstrap)
      OR l.identity_digest<>a.identity_digest OR r.identity_digest<>a.identity_digest THEN
      RAISE EXCEPTION 'Discontinuous receiver range' USING ERRCODE='40001';
    END IF;
    NEW.left_child := l.revision;
    NEW.right_child := r.revision;
    NEW.predecessor := l.predecessor;
    NEW.enrollment_root := r.enrollment_root;
    NEW.digest := sha256(uuid_send(l.revision)||l.digest||uuid_send(r.revision)||r.digest);
  END IF;
  NEW.digest := sha256(convert_to(jsonb_build_array('subject-receiver-baseline/v1',a.job,a.registration,a.bootstrap,
    a.read_definition,a.release_digest,a.owner_epoch,a.physical_target,a.incarnation,a.observation,a.execution,
    a.identity_digest,a.generation,a.enrollment_root,NEW.binding,NEW.first_home,NEW.width,NEW.witness,NEW.digest)::text,'UTF8'));
  SELECT * INTO previous_node FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,NEW.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND (previous_node.digest,previous_node.bootstrap,previous_node.registration,previous_node.left_child,previous_node.right_child) IS DISTINCT FROM
    (NEW.digest,NEW.bootstrap,NEW.registration,NEW.left_child,NEW.right_child) THEN
    RAISE EXCEPTION 'Conflicting receiver range replay' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: compare_subject_compact_range_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.compare_subject_compact_range_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a search.public_filter_ack_authority; member bigint; def text; window_root text; pages integer; adjacent boolean;
  previous bytea;
BEGIN
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority WHERE job=NEW.job AND phase='reconciled'
    AND pass=1 AND fence IS NULL AND NOT fenced_pass;
  SELECT m.birth,semantic.subject_access_definition_v1(m.birth) INTO STRICT member,def
    FROM core.subject_subscription_v1 m JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced
      AND (m.restore_generation,m.registration_generation)=(d.restore_generation,d.registration_generation)
    CROSS JOIN LATERAL core.subject_retention_heads_v1(NEW.first_home) h
    WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap) AND h.restore=m.restore_generation;
  SELECT root INTO STRICT window_root FROM search.subject_compact_window_v1(a.bootstrap,a.execution,NEW.binding,member,NEW.first_home)
    WHERE stop>=NEW.first_home+NEW.width;
  -- Reopen the finite ends above the original bases. An ordinary later
  -- append still covers the captured end. The page stamps cover rewinds.
  IF EXISTS (
    SELECT FROM (SELECT search.public_filter_ack_field(search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),
        'commandEnds')#>>'{}' AS ends FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,a.bootstrap,a.execution,NEW.binding)
        AND s.verified_home<=NEW.first_home AND s.verified_root IS NOT NULL AND NOT s.complete
      ORDER BY s.verified_home DESC LIMIT 1) w
    CROSS JOIN LATERAL jsonb_each_text(w.ends::jsonb) e
    LEFT JOIN LATERAL (SELECT position FROM core.partition WHERE partition_no=e.key::int
      AND position>=e.value::bigint LIMIT 1) h ON true
    WHERE e.key::int>=NEW.first_home AND e.key::int<NEW.first_home+NEW.width AND h.position IS NULL
  ) THEN RAISE EXCEPTION 'Original Subject command end unavailable' USING ERRCODE='40001'; END IF;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home,NEW.width) ON CONFLICT DO NOTHING;
  NEW.witness:=search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,
    search.public_filter_ack_basis_v1(true));
  NEW.bootstrap:=a.bootstrap; NEW.registration:=a.registration; NEW.identity_digest:=a.identity_digest;
  NEW.revision:=gen_random_uuid();
  WITH originals AS (
    SELECT p.first_home,p.predecessor,p.root,lag(p.root) OVER (ORDER BY i) AS prior
    FROM generate_series(NEW.first_home,NEW.first_home+NEW.width-1,32) i
    CROSS JOIN LATERAL (SELECT first_home,predecessor,root FROM search.subject_receiver_page_v1 p
      WHERE (p.birth,p.first_home,p.end_home,p.registration,p.bootstrap)=(member,i,i+32,a.registration,a.bootstrap) LIMIT 1) p
    CROSS JOIN LATERAL (SELECT FROM semantic.subject_access_page_v1 ap WHERE
      (ap.birth,ap.first_home,ap.end_home,ap.definition_digest)=(member,i,i+32,def)
      AND semantic.subject_repair_page_current_v1(ap) LIMIT 1) ap
    CROSS JOIN LATERAL (SELECT FROM core.subject_retention_page_v1 cp
      WHERE (cp.birth,cp.first_home,cp.end_home)=(member,i,i+32) LIMIT 1) cp
  )
  SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
    max(predecessor) FILTER (WHERE first_home=NEW.first_home),max(root) FILTER (WHERE first_home+32=NEW.first_home+NEW.width),
    sha256(convert_to(jsonb_build_array('subject-receiver-compact/v1',a.job,a.bootstrap,member,NEW.binding,
      a.identity_digest,window_root,NEW.witness,jsonb_agg(to_jsonb(originals) ORDER BY first_home))::text,'UTF8'))
    INTO pages,adjacent,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM originals;
  IF pages<>NEW.width/32 OR adjacent IS NOT TRUE OR def IS NULL THEN
    RAISE EXCEPTION 'Original shared receiver pages unavailable' USING ERRCODE='40001'; END IF;
  SELECT n.digest INTO previous FROM search.public_filter_ack_range n WHERE
    (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND previous IS DISTINCT FROM NEW.digest THEN
    RAISE EXCEPTION 'Conflicting compact receiver range replay' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;


--
-- Name: compare_subject_receiver_leaf_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.compare_subject_receiver_leaf_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    search.public_filter_ack_basis_v1(true));
  WITH member AS MATERIALIZED (
    SELECT m.birth,m.restore_generation,semantic.subject_access_definition_v1(m.birth) AS definition_digest
    FROM core.subject_subscription_v1 m JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced
      AND (d.restore_generation,d.registration_generation)=(m.restore_generation,m.registration_generation)
    CROSS JOIN LATERAL core.subject_retention_heads_v1(NEW.first_home) h
    WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap) AND h.restore=m.restore_generation
  ), steps AS MATERIALIZED (
    (SELECT s.verified_home,s.state,s.verified_root FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,a.bootstrap,a.execution,NEW.binding)
        AND s.verified_home<=NEW.first_home AND s.verified_root IS NOT NULL AND NOT s.complete
      ORDER BY s.verified_home DESC LIMIT 1)
    UNION ALL
    SELECT s.verified_home,s.state,s.verified_root FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,a.bootstrap,a.execution,NEW.binding)
        AND s.verified_home>NEW.first_home AND s.verified_home<NEW.first_home+NEW.width
        AND s.verified_root IS NOT NULL AND NOT s.complete
  ), windows AS (
    SELECT steps.*,lead(verified_home,1,NEW.first_home+NEW.width) OVER (ORDER BY verified_home) AS end_home FROM steps
  ), pages AS MATERIALIZED (
    SELECT m.birth,m.restore_generation,p.first_home,p.end_home,p.cuts,ap.cuts AS source_cuts,cp.cuts AS core_cuts
    FROM member m CROSS JOIN LATERAL (
      (SELECT p.* FROM search.subject_receiver_page_v1 p WHERE p.birth=m.birth AND p.first_home<=NEW.first_home
        ORDER BY p.first_home DESC LIMIT 1)
      UNION ALL SELECT p.* FROM search.subject_receiver_page_v1 p WHERE p.birth=m.birth AND
        p.first_home>NEW.first_home AND p.first_home<NEW.first_home+NEW.width
    ) p JOIN semantic.subject_access_page_v1 ap ON (ap.birth,ap.first_home,ap.end_home,ap.definition_digest)=
      (p.birth,p.first_home,p.end_home,m.definition_digest)
    JOIN core.subject_retention_page_v1 cp ON (cp.birth,cp.first_home,cp.end_home)=(p.birth,p.first_home,p.end_home)
    WHERE (p.registration,p.bootstrap)=(a.registration,a.bootstrap) AND
      semantic.subject_access_range_current_v1(ap,greatest(p.first_home,NEW.first_home),least(p.end_home,NEW.first_home+NEW.width))
  ), compared AS (
    SELECT i.home,win.receipt,step.verified_root,win.through_pos,base.cut->>'predecessor' AS predecessor,
      base.cut->>'root' AS root,lag(base.cut->>'root') OVER (ORDER BY i.home) AS prior
    FROM windows step CROSS JOIN LATERAL search.subject_ack_windows_v1(
      step.state,greatest(NEW.first_home,step.verified_home),step.end_home) win
    JOIN pages p ON win.home>=p.first_home AND win.home<p.end_home AND win.member=p.birth::text
    CROSS JOIN LATERAL (SELECT win.home) i
    CROSS JOIN LATERAL (SELECT p.cuts->(i.home-p.first_home) AS cut,p.source_cuts->(i.home-p.first_home) AS src,
      p.core_cuts->(i.home-p.first_home) AS original) base
    CROSS JOIN LATERAL (SELECT epoch,position FROM core.partition WHERE partition_no=i.home AND write_state='active' LIMIT 1) h
    CROSS JOIN LATERAL (SELECT generation FROM core.publication_authority_epoch WHERE home_no=i.home LIMIT 1) g
    CROSS JOIN LATERAL (SELECT position FROM semantic.public_filter_privacy_head WHERE partition_no=i.home
      AND owner_epoch=h.epoch AND NOT population_fenced LIMIT 1) n
    LEFT JOIN core.subject_cleanup_v1 permit ON permit.home=i.home
    WHERE base.src @> base.original AND base.cut-'root'-'predecessor'=base.src-'account'-'claim'
      AND (base.cut->>'home',base.cut->>'epoch',base.cut->>'generation')=(i.home::text,h.epoch::text,g.generation::text)
      AND (win.base,win.receipt,win.epoch)=((base.cut->>'command')::bigint,base.cut->>'receipt',h.epoch)
      AND h.position>=win.through_pos AND n.position>=(base.cut->>'privacy')::bigint
      AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=(h.epoch,g.generation,p.restore_generation)
        AND permit.command_through<=win.base AND permit.privacy_through<=(base.cut->>'privacy')::bigint))

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


--
-- Name: enqueue_identity_receiving_scope(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.enqueue_identity_receiving_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.binding->>'step'='search-canonical-index' THEN
  INSERT INTO search.identity_receiving_native_scope_pending
   (partition_no,job_id,job_epoch,effect_key,plan_transaction_id)
  VALUES (NEW.partition_no,NEW.job_id,NEW.job_epoch,NEW.effect_key,NEW.transaction_id);
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: enroll_retained_copy(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.enroll_retained_copy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target_name text;
BEGIN
  IF TG_TABLE_NAME='public_filter_registration' THEN
    target_name := NEW.physical_target;
  ELSE
    SELECT physical_target INTO target_name FROM search.public_filter_registration
      WHERE (partition_no,id)=(NEW.partition_no,NEW.registration);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_name,741));
  IF EXISTS(SELECT 1 FROM search.identity_writer_gate
    WHERE partition_no=0 AND physical_target=target_name AND publication_fence IS NOT NULL) THEN
    RAISE EXCEPTION 'Search generation is fenced for native publication';
  END IF;
  -- Every native copy in this transaction uses one lane, including a batch of
  -- observations and its independent prepared header. No lock order between lanes is needed.
  INSERT INTO search.retained_copy_lane(partition_no,physical_target,lane,revision)
    VALUES(NEW.partition_no,target_name,(hashtextextended(pg_current_xact_id()::text,0) & 31)::integer,1)
  ON CONFLICT(partition_no,physical_target,lane) DO UPDATE SET revision=search.retained_copy_lane.revision+1;
  RETURN NEW;
END $$;


--
-- Name: group_freshness_checkpoint(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.group_freshness_checkpoint() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE folded jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.consumer,OLD.partition_no,OLD.position)=(NEW.consumer,NEW.partition_no,NEW.position) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' AND OLD.position>0 AND starts_with(OLD.consumer,'search_')
     AND (TG_OP='DELETE' OR NEW.position=0 OR (OLD.consumer,OLD.partition_no)<>(NEW.consumer,NEW.partition_no)) THEN
    DELETE FROM search.freshness_positions WHERE consumer=OLD.consumer AND shard=OLD.partition_no;
    PERFORM search.write_freshness_slot(OLD.consumer,OLD.partition_no,0);
  END IF;
  IF TG_OP<>'DELETE' AND starts_with(NEW.consumer,'search_') THEN
    IF NEW.position>0 THEN
      INSERT INTO search.freshness_positions(consumer,shard,positions)
        VALUES (NEW.consumer,NEW.partition_no,jsonb_build_object(NEW.partition_no,NEW.position))
        ON CONFLICT (consumer,shard) DO UPDATE SET positions=EXCLUDED.positions;
      PERFORM search.write_freshness_slot(NEW.consumer,NEW.partition_no,NEW.position);
    END IF;
    -- A first replay batch can insert a zero checkpoint and advance it in this same
    -- transaction. Taking the head group on insert would invert the subsequent
    -- consumer-group then head-group order. The pending point already serves all readers.
    IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;
    UPDATE search.freshness_positions SET pending=false WHERE consumer='' AND shard=NEW.partition_no AND pending
      RETURNING positions INTO folded;
    IF FOUND THEN
      PERFORM search.write_freshness_slot('',NEW.partition_no,coalesce((folded->>NEW.partition_no::text)::bigint,0));
      IF folded='{}'::jsonb THEN DELETE FROM search.freshness_positions WHERE consumer='' AND shard=NEW.partition_no; END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: guard_public_filter_coverage_page(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.guard_public_filter_coverage_page() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'planned' OR NEW.revision<>1 OR NEW.rounds<>0 OR NEW.charged<>0
      OR NEW.tail IS NOT NULL OR NEW.tail_consumed IS NOT NULL OR NEW.pending IS NOT NULL THEN
      RAISE EXCEPTION 'Native page must begin with a closed plan' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM search.public_filter_observation WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation)
      AND state IN ('closing','closed') FOR UPDATE;
    -- A failed reservation is retired only with its drained original observation.
    -- Never clear or refund it to make an uncertain execution appear completed.
    IF NOT FOUND OR (OLD.pending IS NOT NULL AND OLD.state<>'failed')
      OR EXISTS (SELECT 1 FROM search.public_filter_execution WHERE partition_no=OLD.partition_no AND page_id=OLD.id)
      OR EXISTS (SELECT 1 FROM search.public_filter_reference WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
      OR EXISTS (SELECT 1 FROM search.public_filter_pit WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
    THEN RAISE EXCEPTION 'Native page obligations have not drained' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.work IS DISTINCT FROM OLD.work
    AND NOT search.public_filter_coverage_work_advances(OLD.work,NEW.work) THEN
    RAISE EXCEPTION 'Native page work cannot refund reservations' USING ERRCODE='23514';
  END IF;
  IF (NEW.partition_no,NEW.id,NEW.observation,NEW.registration,NEW.definition,NEW.consumer,NEW.deadline,NEW.reference_token,
      NEW.boundary,NEW.boundary_consumed,NEW.boundary_window,NEW.ceiling)
    IS DISTINCT FROM (OLD.partition_no,OLD.id,OLD.observation,OLD.registration,OLD.definition,OLD.consumer,OLD.deadline,OLD.reference_token,
      OLD.boundary,OLD.boundary_consumed,OLD.boundary_window,OLD.ceiling)
    OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.state='planned' AND NEW.state IN ('open','failed'))
      OR (OLD.state='open' AND NEW.state IN ('open','sealed','failed'))
      OR (OLD.state='sealed' AND NEW.state IN ('finished','failed')))
    OR ((OLD.state<>'open' OR NEW.state<>'open') AND
      (NEW.rounds,NEW.charged,NEW.tail,NEW.tail_consumed,NEW.pending)
        IS DISTINCT FROM (OLD.rounds,OLD.charged,OLD.tail,OLD.tail_consumed,OLD.pending))
    OR (OLD.state='open' AND NEW.state='open' AND NOT (
      (OLD.pending IS NULL AND NEW.pending IS NOT NULL AND NEW.rounds=OLD.rounds+1 AND NEW.tail IS NOT DISTINCT FROM OLD.tail
        AND NEW.charged>OLD.charged AND NEW.tail_consumed IS NOT DISTINCT FROM OLD.tail_consumed)
      OR (OLD.pending IS NOT NULL AND NEW.pending IS NULL AND NEW.rounds=OLD.rounds AND NEW.tail=OLD.pending
        AND NEW.charged<=OLD.charged AND NEW.tail_consumed IS NULL)
      OR (OLD.pending IS NULL AND NEW.pending IS NULL AND NEW.tail IS NOT DISTINCT FROM OLD.tail
        AND OLD.tail IS NOT NULL
        AND NEW.rounds=OLD.rounds AND NEW.charged=OLD.charged
        AND OLD.tail_consumed IS NULL AND NEW.tail_consumed IS NOT NULL)
      -- Persist a funded command without changing its pending custody. This is
      -- used by the same atomic engine-fence statement, before external I/O.
      OR (OLD.pending IS NOT NULL AND NEW.pending=OLD.pending
        AND (NEW.rounds,NEW.charged,NEW.tail,NEW.tail_consumed)
          IS NOT DISTINCT FROM (OLD.rounds,OLD.charged,OLD.tail,OLD.tail_consumed)
        AND NEW.work IS DISTINCT FROM OLD.work
        AND (semantic.public_filter_native_json(NEW.work::jsonb)->>'statements')::numeric
          >(semantic.public_filter_native_json(OLD.work::jsonb)->>'statements')::numeric
        AND (semantic.public_filter_native_json(NEW.work::jsonb)->>'frontierWrites')::numeric
          >(semantic.public_filter_native_json(OLD.work::jsonb)->>'frontierWrites')::numeric)))
    OR (NEW.state IN ('sealed','finished') AND (NEW.pending IS NOT NULL OR NEW.tail IS NULL
      OR NEW.tail_consumed IS NULL OR NEW.rounds=0))
  THEN RAISE EXCEPTION 'Invalid native page transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_public_filter_page_execution(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.guard_public_filter_page_execution() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.page_id IS NOT NULL AND OLD.page_status<>'complete' THEN
      -- Only a false dispatch fence excludes unknown engine successors. Older
      -- children and lost engine receipts retain their original obligations.
      -- Known locators must also have left native custody through actual drain.
      PERFORM 1 FROM search.public_filter_observation o
      JOIN search.public_filter_coverage_page p ON (p.partition_no,p.id)=(OLD.partition_no,OLD.page_id)
        AND p.observation=o.observation AND p.state='failed' AND p.pending=OLD.id
        AND p.rounds=OLD.page_ordinal AND p.charged>=OLD.page_size
      WHERE (o.partition_no,o.observation)=(OLD.partition_no,OLD.observation)
        AND OLD.page_engine_started IS FALSE
        AND o.state IN ('closing','closed')
        AND NOT EXISTS (SELECT 1 FROM search.public_filter_reference f
          WHERE (f.partition_no,f.observation)=(o.partition_no,o.observation))
        AND NOT EXISTS (SELECT 1 FROM search.public_filter_pit t
          WHERE (t.partition_no,t.observation)=(o.partition_no,o.observation))
      FOR UPDATE OF o,p;
      IF NOT FOUND THEN RAISE EXCEPTION 'Native dispatched child has not drained' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.page_id IS NOT NULL THEN
      PERFORM 1 FROM search.public_filter_coverage_page WHERE (partition_no,id)=(NEW.partition_no,NEW.page_id)
        AND observation=NEW.observation AND state='open' AND pending=NEW.id AND rounds=NEW.page_ordinal FOR UPDATE;
      IF NOT FOUND OR NEW.page_status<>'dispatched' OR NEW.consumer_window IS NOT NULL
        OR NEW.page_engine_started IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'Native child was not reserved' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.page_engine_started IS DISTINCT FROM NEW.page_engine_started THEN
    IF OLD.page_id IS NULL OR OLD.page_engine_started IS DISTINCT FROM false
      OR NEW.page_engine_started IS DISTINCT FROM true OR OLD.page_status<>'dispatched'
      OR NEW.page_status<>'dispatched' OR NEW.execution IS DISTINCT FROM OLD.execution
      OR NEW.consumer_window IS NOT NULL OR NEW.page_raw IS NOT NULL THEN
      RAISE EXCEPTION 'Native engine dispatch is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM search.public_filter_coverage_page p
    JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(p.partition_no,p.observation)
    WHERE (p.partition_no,p.id)=(OLD.partition_no,OLD.page_id) AND p.observation=OLD.observation
      AND p.state='open' AND p.pending=OLD.id AND o.state='open'
      AND p.deadline>floor(extract(epoch FROM clock_timestamp())*1000)
      -- The page retains its original user; another live user is not its lease.
      -- Legacy roots remain unknown and cannot acquire a reference by inference.
      AND p.reference_token IS NOT NULL
      AND EXISTS (SELECT 1 FROM search.public_filter_reference f
        WHERE (f.partition_no,f.observation,f.token)=(o.partition_no,o.observation,p.reference_token)
          AND f.expires_at>floor(extract(epoch FROM clock_timestamp())*1000) FOR SHARE OF f)
    FOR UPDATE OF p FOR SHARE OF o;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native engine dispatch is not admitted' USING ERRCODE='23514'; END IF;
  END IF;
  IF OLD.page_id IS DISTINCT FROM NEW.page_id OR (OLD.page_id IS NOT NULL AND (
      (NEW.partition_no,NEW.observation,NEW.id,NEW.page_ordinal,NEW.page_parent,NEW.page_consumed,NEW.page_size)
       IS DISTINCT FROM (OLD.partition_no,OLD.observation,OLD.id,OLD.page_ordinal,OLD.page_parent,OLD.page_consumed,OLD.page_size))) THEN
    RAISE EXCEPTION 'Native page execution identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.page_id IS NOT NULL AND (NEW.execution IS DISTINCT FROM OLD.execution OR NEW.consumer_window IS DISTINCT FROM OLD.consumer_window
      OR NEW.page_status IS DISTINCT FROM OLD.page_status OR NEW.page_raw IS DISTINCT FROM OLD.page_raw) THEN
    IF OLD.page_id IS NULL OR OLD.page_status<>'dispatched' OR NEW.page_status<>'complete'
      OR OLD.consumer_window IS NOT NULL OR NEW.consumer_window IS NULL THEN
      RAISE EXCEPTION 'Native page execution is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM search.public_filter_coverage_page WHERE (partition_no,id)=(OLD.partition_no,OLD.page_id)
      AND state='open' AND pending=OLD.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native page is sealed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: invalidate_population_verification(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.invalidate_population_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE search.public_filter_prepared p
     SET verified_raw=0,verified_output=0,population_verified=false,segment_state='building'
    FROM (SELECT partition_no,registration,build,generation,min(raw_ordinal) AS changed
            FROM original_segments GROUP BY partition_no,registration,build,generation) s
   WHERE (p.partition_no,p.registration,p.build,p.generation)=(s.partition_no,s.registration,s.build,s.generation)
     AND p.population_job IS NOT NULL AND p.raw_exhausted AND p.state='active'
     AND p.segment_state IN ('building','complete') AND p.verified_raw>s.changed;
  RETURN NULL;
END
$$;


--
-- Name: invalidate_public_filter_repair_evidence(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.invalidate_public_filter_repair_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE search.public_filter_repair_verification SET revision=revision+1,evidence_revision=evidence_revision+1,progress=NULL
    WHERE (partition_no,observation,execution)=(OLD.partition_no,OLD.observation,OLD.execution);
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (OLD.partition_no,OLD.observation,OLD.execution)<>(NEW.partition_no,NEW.observation,NEW.execution)) THEN
    UPDATE search.public_filter_repair_verification SET revision=revision+1,evidence_revision=evidence_revision+1,progress=NULL
    WHERE (partition_no,observation,execution)=(NEW.partition_no,NEW.observation,NEW.execution);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: lock_retained_copy_target(integer, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.lock_retained_copy_target(integer, text) RETURNS TABLE(partition_no integer, physical_target text, incarnation text)
    LANGUAGE sql ROWS 1
    AS $_$
  SELECT t.partition_no,t.physical_target,t.incarnation FROM search.public_filter_target t
  WHERE (t.partition_no,t.physical_target)=($1,$2) FOR SHARE
$_$;


--
-- Name: lose_public_filter_ack_cut(uuid); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.lose_public_filter_ack_cut(cut uuid) RETURNS void
    LANGUAGE sql
    AS $$
  UPDATE search.public_filter_ack_home_clock SET continuity=continuity+1,revision=revision+1
    WHERE (bootstrap,first_home,width)=(cut,0,4096)
$$;


--
-- Name: maintain_freshness_home(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.maintain_freshness_home() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    -- Truncating core.partition also requires truncating its referencing checkpoints.
    TRUNCATE search.freshness_home;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.partition_no, OLD.position) = (NEW.partition_no, NEW.position) THEN RETURN NULL; END IF;

  IF TG_TABLE_NAME = 'consumer_checkpoint' THEN
    -- All native consumers count, including those read via the generic fallback.
    -- An observed ceiling never decreases, so a covered checkpoint needs no row lock.
    IF NEW.position > 0 THEN
      INSERT INTO search.freshness_home AS h(partition_no, checkpoint_ceiling)
      SELECT NEW.partition_no, NEW.position WHERE NOT EXISTS (
        SELECT 1 FROM search.freshness_home prior
        WHERE prior.partition_no = NEW.partition_no AND prior.checkpoint_ceiling >= NEW.position
      )
      ON CONFLICT (partition_no) DO UPDATE SET checkpoint_ceiling = EXCLUDED.checkpoint_ceiling
        WHERE h.checkpoint_ceiling < EXCLUDED.checkpoint_ceiling;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.partition_no <> NEW.partition_no) THEN
      UPDATE search.freshness_home SET head = 0 WHERE partition_no = OLD.partition_no AND head <> 0;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      INSERT INTO search.freshness_home AS h(partition_no, head) VALUES (NEW.partition_no, NEW.position)
      ON CONFLICT (partition_no) DO UPDATE SET head = EXCLUDED.head WHERE h.head <> EXCLUDED.head;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: mark_freshness_position_change(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.mark_freshness_position_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW.consumer, NEW.shard, NEW.positions) IS DISTINCT FROM
      (OLD.consumer, OLD.shard, OLD.positions) THEN
    NEW.change_xid := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: mark_public_filter_repair_allocation(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.mark_public_filter_repair_allocation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM search.advance_public_filter_repair_authority(OLD.prefix||'discovery-g'||OLD.generation,0);
  IF TG_OP = 'UPDATE' AND (OLD.prefix,OLD.generation)<>(NEW.prefix,NEW.generation) THEN
    PERFORM search.advance_public_filter_repair_authority(NEW.prefix||'discovery-g'||NEW.generation,0);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: mark_public_filter_repair_copy(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.mark_public_filter_repair_copy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search.advance_public_filter_repair_authority(OLD.prefix||'discovery-g'||OLD.generation,OLD.route/16);
  ELSE
    PERFORM search.advance_public_filter_repair_authority(NEW.prefix||'discovery-g'||NEW.generation,NEW.route/16);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: mark_public_filter_repair_owner(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.mark_public_filter_repair_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM search.advance_public_filter_repair_authority('',NEW.partition_no);
  RETURN NULL;
END
$$;


--
-- Name: mark_public_filter_repair_source_change(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.mark_public_filter_repair_source_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search.advance_public_filter_repair_authority(TG_ARGV[0],OLD.partition_no);
  ELSE
    PERFORM search.advance_public_filter_repair_authority(TG_ARGV[0],NEW.partition_no);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: mark_public_filter_repair_writer(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.mark_public_filter_repair_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
      (OLD.physical_target,OLD.partition_no)<>(NEW.physical_target,NEW.partition_no)) THEN
    PERFORM search.advance_public_filter_repair_authority(OLD.physical_target,OLD.partition_no);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM search.advance_public_filter_repair_authority(NEW.physical_target,NEW.partition_no);
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: pin_subject_source_format_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.pin_subject_source_format_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT coalesce((SELECT j.subscription_protocol FROM core.subject_subscription_v1 m
    JOIN search.generation_publication j ON (j.partition_no,j.job)=(0,m.job)
    WHERE m.bootstrap=NEW.bootstrap AND m.definition=NEW.read_definition AND NEW.snapshot_kind='prepared'
      AND semantic.public_filter_native_json(NEW.consumer::jsonb)=m.consumer),0) INTO NEW.subscription_protocol;
  RETURN NEW;
END $$;


--
-- Name: prepare_public_filter_ack(uuid, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.prepare_public_filter_ack(job_id uuid, leaf_limit integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  chain text;
  available integer;
  witness_cut search.public_filter_ack_basis_v1;
  local_cut bytea;
  span integer := 4096;
  first integer := 0;
  left_id uuid;
  right_id uuid;
BEGIN
  IF leaf_limit NOT BETWEEN 1 AND 16 OR leaf_limit IS NULL THEN
    RAISE EXCEPTION 'Invalid receiver leaf allowance' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM search.public_filter_ack_authority WHERE job=job_id AND phase='reconciled' AND pass=1
    AND fence IS NULL AND NOT fenced_pass;
  IF NOT FOUND OR EXISTS (SELECT FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,job_id)) THEN RETURN 0; END IF;
  SELECT s.verified_binding,s.verified_home+coalesce(search.public_filter_ack_field(
    search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),'count')::integer,1)
    INTO chain,available FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_home IS NOT NULL
    ORDER BY s.verified_home DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  witness_cut := search.public_filter_ack_basis_v1(search.shared_subject_job_v1(a.job));
  local_cut := search.public_filter_ack_range_witness(a.bootstrap,0,4096,witness_cut);
  IF local_cut IS NULL OR EXISTS (SELECT FROM search.public_filter_ack_range n WHERE
    (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,0,4096,local_cut)) THEN RETURN -2; END IF;
  LOOP
    IF first>=available THEN RETURN -1; END IF;
    IF span<=leaf_limit AND first+span<=available THEN EXIT; END IF;
    local_cut := search.public_filter_ack_range_witness(a.bootstrap,first,span/2,witness_cut);
    SELECT revision INTO left_id FROM search.public_filter_ack_range n WHERE
      (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first,span/2,local_cut);
    IF left_id IS NOT NULL THEN
      local_cut := search.public_filter_ack_range_witness(a.bootstrap,first+span/2,span/2,witness_cut);
      SELECT revision INTO right_id FROM search.public_filter_ack_range n WHERE
        (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first+span/2,span/2,local_cut);
      IF right_id IS NOT NULL THEN EXIT; END IF;
      first := first+span/2;
    END IF;
    span := span/2;
    left_id := NULL;
    right_id := NULL;
  END LOOP;
  INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width,left_child,right_child)
    VALUES (0,job_id,chain,first,span,left_id,right_id) ON CONFLICT DO NOTHING;
  RETURN CASE WHEN left_id IS NULL THEN span ELSE 0 END + 1;
END $$;


--
-- Name: prepare_public_filter_ack_batch(uuid, integer, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.prepare_public_filter_ack_batch(job_id uuid, key_limit integer, byte_limit integer) RETURNS TABLE(points integer, proof_bytes integer, range_writes integer, result_writes integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  chain text;
  available integer;
  foreign_cut search.public_filter_ack_basis_v1;
  local_cut bytea;
  span integer := 4096;
  first_no integer := 0;
  leaf_limit integer;
  members integer;
  left_id uuid;
  right_id uuid;
  changed integer;
  comparison_points integer;
BEGIN
  IF key_limit IS NULL OR key_limit NOT BETWEEN 180 AND 1000 OR
     byte_limit IS NULL OR byte_limit NOT BETWEEN 90112 AND 4194304 THEN
    RAISE EXCEPTION 'Invalid receiver range allowance' USING ERRCODE='22023';
  END IF;
  points := 20; proof_bytes := 65536; range_writes := 0; result_writes := 0;
  leaf_limit := least(32,(key_limit-160)/20,(byte_limit-65536)/24576);
  SELECT * INTO a FROM search.public_filter_ack_authority WHERE job=job_id AND phase='reconciled' AND pass=1
    AND fence IS NULL AND NOT fenced_pass;
  IF FOUND AND NOT EXISTS (SELECT FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,job_id)) THEN
    SELECT s.verified_binding,s.verified_home+coalesce(search.public_filter_ack_field(
      search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),'count')::integer,1)
      INTO chain,available FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_home IS NOT NULL
      ORDER BY s.verified_home DESC LIMIT 1;
  END IF;
  IF chain IS NOT NULL THEN
    points := points+28;
    foreign_cut := search.public_filter_ack_basis_v1(search.shared_subject_job_v1(a.job));
    local_cut := search.public_filter_ack_range_witness(a.bootstrap,0,4096,foreign_cut);
    IF local_cut IS NOT NULL AND NOT EXISTS (SELECT FROM search.public_filter_ack_range n WHERE
      (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,0,4096,local_cut)) THEN
      LOOP
        EXIT WHEN first_no>=available;
        members := 0;
        left_id := NULL;
        right_id := NULL;
        IF span<=leaf_limit THEN
          -- The next verified window completes this same leaf. Smaller
          -- fragments here would be compared again by its eventual direct leaf.
          EXIT WHEN first_no+span>available;
          members := span;
        ELSE
          -- Two indexed child lookups, each with its gate and local clock.
          EXIT WHEN points+3>key_limit;
          points := points+3;
          local_cut := search.public_filter_ack_range_witness(a.bootstrap,first_no,span/2,foreign_cut);
          SELECT revision INTO left_id FROM search.public_filter_ack_range n WHERE
            (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first_no,span/2,local_cut);
          IF left_id IS NULL THEN span := span/2; CONTINUE; END IF;
          EXIT WHEN points+3>key_limit;
          points := points+3;
          local_cut := search.public_filter_ack_range_witness(a.bootstrap,first_no+span/2,span/2,foreign_cut);
          SELECT revision INTO right_id FROM search.public_filter_ack_range n WHERE
            (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first_no+span/2,span/2,local_cut);
          IF right_id IS NULL THEN first_no := first_no+span/2; span := span/2; CONTINUE; END IF;
        END IF;

        -- Reserve the comparison's native authority, witness, replay and FK
        -- reads. A direct leaf also consumes the original step for every home.
        comparison_points := CASE WHEN members>0 THEN 40+20*members ELSE 64 END;
        EXIT WHEN points+comparison_points>key_limit;
        points := points+comparison_points;
        proof_bytes := proof_bytes+24576*members;
        -- Stage the same inputs the before-insert verifier requires. Count only
        -- actual writes, including first use of a clock or a home marker.
        IF members>0 THEN
          UPDATE search.public_filter_coverage_home h SET baseline_delta=true
            WHERE (h.partition_no,h.registration,h.baseline_bootstrap)=(0,a.registration,a.bootstrap)
              AND h.source_home>=first_no AND h.source_home<first_no+span AND h.baseline_delta IS NULL;
          GET DIAGNOSTICS changed = ROW_COUNT;
          result_writes := result_writes+changed;
        END IF;
        INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
          VALUES(0,a.registration,a.bootstrap,first_no/greatest(span,16)*greatest(span,16),greatest(span,16))
          ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS changed = ROW_COUNT;
        result_writes := result_writes+changed;
        INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width,left_child,right_child)
          VALUES(0,job_id,chain,first_no,span,left_id,right_id) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS changed = ROW_COUNT;
        range_writes := range_writes+changed;
        result_writes := result_writes+changed;
        EXIT;
      END LOOP;
    END IF;
  END IF;
  RETURN NEXT;
END $$;


--
-- Name: prepare_subject_ack_prefix_v1(uuid, integer, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.prepare_subject_ack_prefix_v1(job_id uuid, key_limit integer, byte_limit integer) RETURNS TABLE(points integer, proof_bytes integer, range_writes integer, result_writes integer)
    LANGUAGE plpgsql
    AS $$
DECLARE a search.public_filter_ack_authority; chain text; available integer; foreign_cut search.public_filter_ack_basis_v1; local_cut bytea;
  first_no integer; span integer; half integer; left_id uuid; right_id uuid; changed integer;
  member bigint; compact_stop integer; direct boolean; stamps boolean; pages integer;
  leaf_limit integer; comparison_points integer; comparison_bytes integer;
BEGIN
  IF key_limit IS NULL OR key_limit NOT BETWEEN 180 AND 1000 OR byte_limit IS NULL OR
    byte_limit NOT BETWEEN 90112 AND 4194304 THEN RAISE EXCEPTION 'Invalid Subject ACK allowance'; END IF;
  points:=24; proof_bytes:=16384; range_writes:=0; result_writes:=0;
  SELECT * INTO a FROM search.public_filter_ack_authority WHERE job=job_id AND phase='reconciled'
    AND pass=1 AND NOT fenced_pass AND fence IS NULL AND search.shared_subject_job_v1(job_id);
  IF FOUND AND NOT EXISTS (SELECT FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,job_id)) THEN
    SELECT s.verified_binding,s.verified_home+coalesce(search.public_filter_ack_field(
      search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),'count')::integer,1)
      INTO chain,available FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_home IS NOT NULL
      ORDER BY s.verified_home DESC LIMIT 1;
  END IF;
  IF chain IS NULL THEN RETURN NEXT; RETURN; END IF;
  -- Retain the ordinary smaller funded leaves when a full offer is unavailable
  -- at the end. Before then wait for at least one completely verified interval.
  leaf_limit:=CASE WHEN available=4096 THEN least(32,(key_limit-184)/20,(byte_limit-81920)/24576) ELSE 32 END;
  IF leaf_limit<1 OR available<leaf_limit THEN RETURN NEXT; RETURN; END IF;
  SELECT m.birth INTO STRICT member FROM core.subject_subscription_v1 m WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap);
  points:=points+21;
  foreign_cut:=search.public_filter_ack_basis_v1(true);
  local_cut:=search.public_filter_ack_range_witness(a.bootstrap,0,4096,foreign_cut);
  IF EXISTS (SELECT FROM search.public_filter_ack_range n WHERE
    (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=
    (0,job_id,chain,0,4096,local_cut)) THEN
    RETURN NEXT; RETURN;
  END IF;
  -- The root gate and foreign lanes stay locked until commit. Each descent
  -- checks the current clock and exact revision of both children. The insert
  -- trigger independently rereads them, locks their FKs, and binds adjacency.
  <<funded>> LOOP
    first_no:=0; span:=4096; direct:=false;
    LOOP
      IF span<=leaf_limit THEN
        -- A stale compact interval can spend part of this offer on stamp checks.
        -- Compare only a funded aligned leaf. The same descent joins its current children on replay.
        leaf_limit:=least(leaf_limit,(key_limit-points-40)/20,(byte_limit-proof_bytes-65536)/24576);
        EXIT WHEN span<=leaf_limit;
        EXIT funded WHEN range_writes>0 OR leaf_limit<1 OR first_no+span>available;
      END IF;
      IF span BETWEEN 64 AND 512 AND first_no+span<=available THEN
        EXIT funded WHEN points+1>key_limit;
        points:=points+1;
        SELECT stop INTO compact_stop FROM search.subject_compact_window_v1(a.bootstrap,a.execution,chain,member,first_no);
        IF compact_stop>=first_no+span THEN
          pages:=span/32;
          -- The planning recheck costs a page and its revision lookups. A
          -- changed stamp leaves this span to its children and detailed leaves.
          EXIT funded WHEN points+6*pages>key_limit;
          points:=points+6*pages;
          SELECT count(*)=pages INTO stamps FROM generate_series(first_no,first_no+span-1,32) i
            CROSS JOIN LATERAL (SELECT FROM semantic.subject_access_page_v1 p
              WHERE (p.birth,p.first_home,p.end_home)=(member,i,i+32)
                AND semantic.subject_repair_page_current_v1(p) LIMIT 1) current_page;
          IF stamps THEN direct:=true; EXIT; END IF;
        END IF;
      END IF;
      half:=span/2;
      EXIT funded WHEN points+3>key_limit;
      points:=points+3;
      local_cut:=search.public_filter_ack_range_witness(a.bootstrap,first_no,half,foreign_cut);
      SELECT revision INTO left_id FROM search.public_filter_ack_range n WHERE
        (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=
        (0,job_id,chain,first_no,half,local_cut);
      IF left_id IS NULL THEN span:=half; CONTINUE; END IF;
      EXIT funded WHEN first_no+half>=available OR points+3>key_limit;
      points:=points+3;
      local_cut:=search.public_filter_ack_range_witness(a.bootstrap,first_no+half,half,foreign_cut);
      SELECT revision INTO right_id FROM search.public_filter_ack_range n WHERE
        (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first_no+half,half,
          local_cut);
      IF right_id IS NOT NULL THEN EXIT; END IF;
      first_no:=first_no+half; span:=half;
    END LOOP;
    EXIT WHEN first_no+span>available;
    IF direct THEN
      left_id:=NULL; right_id:=NULL;
      -- Native binding, original closure of at most 64 keys, current foreign
      -- and local clocks; each 32-home page costs three originals and its stamp.
      -- Reopen one retained step (at most 16 KiB) and its 64 finite command ends.
      comparison_points:=201+8*pages; comparison_bytes:=90112+8192*pages;
    ELSIF span<=leaf_limit THEN
      left_id:=NULL; right_id:=NULL;
      comparison_points:=40+20*span; comparison_bytes:=65536+24576*span;
    ELSE
      comparison_points:=64; comparison_bytes:=65536;
    END IF;
    EXIT WHEN points+comparison_points>key_limit OR proof_bytes+comparison_bytes>byte_limit;
    points:=points+comparison_points; proof_bytes:=proof_bytes+comparison_bytes;
    INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
      VALUES(0,a.registration,a.bootstrap,first_no/greatest(span,16)*greatest(span,16),greatest(span,16))
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed=ROW_COUNT;
    result_writes:=result_writes+changed;
    INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width,left_child,right_child)
      VALUES(0,job_id,chain,first_no,span,left_id,right_id) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed=ROW_COUNT;
    range_writes:=range_writes+changed; result_writes:=result_writes+changed;
    EXIT WHEN changed=0 OR span=4096;
  END LOOP;
  RETURN NEXT;
END $$;


--
-- Name: prevent_receiving_plan_mutation(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.prevent_receiving_plan_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Native receiving plans are immutable'; END; $$;


--
-- Name: private_population_build(uuid, text, text, jsonb); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.private_population_build(original_job uuid, original_registration text, original_build text, original_consumer jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (
    SELECT FROM search.generation_publication j
    JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=
      (j.partition_no,j.physical_target,j.native_incarnation)
    JOIN search.public_filter_registration r ON (r.partition_no,r.physical_target)=(t.partition_no,t.physical_target)
    JOIN semantic.public_filter_bootstrap b ON b.partition_no=j.partition_no AND b.bootstrap=substring(original_build FROM 3)::uuid
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
    WHERE (j.partition_no,j.job)=(0,original_job) AND j.phase='reconciled' AND j.source_home=0
      AND j.consumer=original_consumer AND j.binding->>'readDefinition'=b.read_definition::text
      AND j.fence IS NULL AND j.bootstrap IS NULL AND j.queried IS NULL AND j.observation IS NULL AND j.execution IS NULL
      AND r.id=original_registration AND r.state='active' AND r.consumer_bootstrap=original_build AND r.consumer_work IS NOT NULL
      AND original_build='0:'||b.bootstrap::text AND b.snapshot_kind='prepared' AND b.state='begun' AND b.queried IS NULL
      AND b.coverage_publication IS NULL AND b.publication_job IS NULL AND b.publication_observation IS NULL
      AND b.publication_execution IS NULL AND b.account_after=4096 AND b.coverage_after=4096
      AND b.coverage_sealed AND b.coverage_root IS NOT NULL AND b.coverage_generation IS NOT NULL
  )
$$;


--
-- Name: public_filter_ack_basis_v1(boolean); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_basis_v1(shared boolean) RETURNS search.public_filter_ack_basis_v1
    LANGUAGE plpgsql STRICT
    AS $$
DECLARE basis search.public_filter_ack_basis_v1;
BEGIN
  IF shared THEN
    basis.authority:=search.public_filter_ack_witness(ARRAY['','@ack-retention']);
    SELECT CASE WHEN count(subject_pages)=4 THEN string_agg(subject_pages,''::bytea ORDER BY lane) END INTO basis.pages FROM
      (SELECT lane,subject_pages FROM search.public_filter_repair_authority
       WHERE physical_target='@source' ORDER BY lane FOR SHARE) locked;
    IF basis.pages IS NULL THEN RAISE EXCEPTION 'Missing Subject ACK page clocks' USING ERRCODE='40001'; END IF;
  ELSE
    basis.authority:=search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']);
  END IF;
  RETURN basis;
END $$;


--
-- Name: public_filter_ack_checkpoint_loss(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_checkpoint_loss() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
  IF OLD.consumer ~ '^public_filter_[0-9a-f]{32}$' THEN
    PERFORM search.lose_public_filter_ack_cut(substring(OLD.consumer FROM 15)::uuid);
  END IF;
  RETURN NULL;
END $_$;


--
-- Name: public_filter_ack_field(jsonb, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_field(obj jsonb, field_name text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT entry->1->1 FROM jsonb_array_elements(obj) entry WHERE entry->>0=field_name
$$;


--
-- Name: public_filter_ack_range_witness(uuid, integer, integer, bytea); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_range_witness(cut uuid, first_no integer, span integer, foreign_cut bytea) RETURNS bytea
    LANGUAGE plpgsql STRICT
    AS $$
DECLARE
  gate_id uuid;
  lifetime bigint;
  local_cut bytea;
BEGIN
  SELECT incarnation,continuity INTO gate_id,lifetime FROM search.public_filter_ack_home_clock
    WHERE (bootstrap,first_home,width)=(cut,0,4096) FOR SHARE;
  -- A fresh statement snapshot sees a mutation which released the gate while
  -- this read waited. Repeatable-read callers retry on serialization failure.
  SELECT uuid_send(incarnation)||int8send(revision) INTO local_cut FROM search.public_filter_ack_home_clock
    WHERE (bootstrap,first_home,width)=(cut,first_no/greatest(span,16)*greatest(span,16),greatest(span,16));
  RETURN sha256(foreign_cut||uuid_send(gate_id)||int8send(lifetime)||local_cut);
END $$;


--
-- Name: public_filter_ack_range_witness(uuid, integer, integer, search.public_filter_ack_basis_v1); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_range_witness(cut uuid, first_no integer, span integer, basis search.public_filter_ack_basis_v1) RETURNS bytea
    LANGUAGE sql STRICT
    AS $$
  SELECT search.public_filter_ack_range_witness(cut,first_no,span,
    CASE WHEN basis.pages IS NULL THEN basis.authority ELSE sha256(basis.authority ||
      substring(basis.pages FROM 1+16*(first_no/32) FOR 16*((first_no+span-1)/32-first_no/32+1))) END)
$$;


--
-- Name: public_filter_ack_receipt_loss(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_receipt_loss() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM search.lose_public_filter_ack_cut(OLD.bootstrap);
  RETURN NULL;
END $$;


--
-- Name: public_filter_ack_settlement_digest(jsonb); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_settlement_digest(state jsonb) RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    (SELECT jsonb_agg(entry ORDER BY entry->>0) FROM jsonb_array_elements(state) entry WHERE entry->>0<>'fence'),
    (SELECT jsonb_agg(entry ORDER BY entry->>0) FROM jsonb_array_elements(search.public_filter_ack_field(state,'fence')) entry
      WHERE entry->>0 NOT IN ('transaction','refresh'))
  )::text,'UTF8'))
$$;


--
-- Name: public_filter_ack_window(text, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_window(step_state text, home integer) RETURNS TABLE(epoch integer, base bigint, through_pos bigint, receipt text)
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
DECLARE
  body jsonb := step_state::jsonb->1;
  input jsonb := search.public_filter_ack_field(body,'input');
  batch jsonb := search.public_filter_ack_field(body,'windowBatch');
  bridge jsonb;
  following jsonb;
  packed bytea;
  idx integer;
  members integer;
BEGIN
  IF search.public_filter_ack_field(input,'phase')='"window"' AND batch IS NOT NULL THEN
    idx := home-(search.public_filter_ack_field(batch,'from')::integer);
    members := search.public_filter_ack_field(batch,'count')::integer;
    IF idx NOT BETWEEN 0 AND members-1 OR members NOT BETWEEN 1 AND 128 THEN RETURN; END IF;
    packed := decode(search.public_filter_ack_field(batch,'packed')#>>'{}','base64');
    IF length(packed)<>44*members THEN RETURN; END IF;
    epoch := ('x'||encode(substring(packed FROM idx*44+1 FOR 4),'hex'))::bit(32)::integer;
    base := ('x'||encode(substring(packed FROM idx*44+5 FOR 8),'hex'))::bit(64)::bigint;
    receipt := encode(substring(packed FROM idx*44+13 FOR 32),'hex');
    IF search.public_filter_ack_field(batch,'through') IS NULL THEN through_pos := base;
    ELSE through_pos := (search.public_filter_ack_field(batch,'through')->idx->>1)::bigint; END IF;
  ELSIF search.public_filter_ack_field(input,'phase')='"bridge"' THEN
    bridge := search.public_filter_ack_field(input,'bridge');
    following := search.public_filter_ack_field(body,'next');
    IF (search.public_filter_ack_field(bridge,'partition')::integer=home AND
      search.public_filter_ack_field(following,'phase')='"window"' AND
      search.public_filter_ack_field(following,'partition')::integer=home+1) IS NOT TRUE THEN RETURN; END IF;
    epoch := search.public_filter_ack_field(bridge,'epoch')::integer;
    base := (search.public_filter_ack_field(bridge,'base')#>>'{}')::bigint;
    through_pos := (search.public_filter_ack_field(bridge,'through')#>>'{}')::bigint;
    receipt := search.public_filter_ack_field(bridge,'receipt')#>>'{}';
  ELSE RETURN;
  END IF;
  IF epoch>0 AND base>=0 AND through_pos>=base AND receipt ~ '^[0-9a-f]{64}$' THEN RETURN NEXT; END IF;
END $_$;


--
-- Name: public_filter_ack_witness(text[]); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_ack_witness(targets text[]) RETURNS bytea
    LANGUAGE sql
    AS $$
  SELECT CASE WHEN count(*)=4*cardinality(targets) THEN
    sha256(convert_to(jsonb_agg(jsonb_build_array(physical_target,lane,revision) ORDER BY physical_target,lane)::text,'UTF8')) END
  FROM (SELECT * FROM search.public_filter_repair_authority WHERE physical_target=ANY(targets)
    ORDER BY physical_target,lane FOR SHARE) locked
$$;


--
-- Name: public_filter_baseline_interval(integer, text, uuid, integer, integer, text, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_baseline_interval(owner_partition integer, registration_id text, bootstrap_id uuid, first_home integer, after_home integer, first_root text, final_root text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $_$
  SELECT CASE WHEN c.subscription_protocol=1 THEN EXISTS (
    SELECT FROM core.subject_subscription_v1 s JOIN search.subject_receiver_page_v1 p ON p.birth=s.birth
    WHERE s.bootstrap=$3 AND (p.registration,p.bootstrap,p.first_home,p.end_home,p.predecessor,p.root)=($2,$3,$4,$5,$6,$7)
  ) ELSE search.public_filter_legacy_baseline_interval($1,$2,$3,$4,$5,$6,$7) END
  FROM search.public_filter_coverage_preparation c WHERE (c.partition_no,c.registration,c.bootstrap)=($1,$2,$3)
$_$;


--
-- Name: public_filter_coverage_work_advances(text, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_coverage_work_advances(before_encoded text, after_encoded text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
DECLARE
  before_work jsonb := semantic.public_filter_native_json(before_encoded::jsonb);
  after_work jsonb := semantic.public_filter_native_json(after_encoded::jsonb);
  counter record;
  before_value numeric;
  after_value numeric;
BEGIN
  IF jsonb_typeof(before_work) IS DISTINCT FROM 'object'
    OR jsonb_typeof(after_work) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(before_work) key)
      IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(after_work) key)
    OR NOT before_work ?& ARRAY['inputKeys','candidates','accessPoints','dependencyPoints',
      'engineSearches','engineIteratorSteps','outputSlots','resultWrites','frontierWrites',
      'statements','rows','bytes','engineRequests'] THEN
    RETURN false;
  END IF;
  FOR counter IN SELECT key,value FROM jsonb_each(before_work) LOOP
    IF jsonb_typeof(counter.value) IS DISTINCT FROM 'number'
      OR jsonb_typeof(after_work->counter.key) IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    before_value := counter.value::text::numeric;
    after_value := (after_work->counter.key)::text::numeric;
    IF before_value<0 OR before_value<>trunc(before_value)
      OR after_value<before_value OR after_value<>trunc(after_value)
      OR after_value>9007199254740991 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;


--
-- Name: public_filter_first_change_v1(text, bigint); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_first_change_v1(reg text, since bigint) RETURNS TABLE(source_home integer, source_epoch integer)
    LANGUAGE sql STABLE ROWS 1
    AS $$
  (SELECT h.source_home,h.source_epoch FROM search.public_filter_coverage_home h WHERE
    (h.partition_no,h.registration)=(0,reg) AND h.last_change_generation>since ORDER BY last_change_generation,h.source_home LIMIT 1)
  UNION ALL
  (SELECT d.home,d.epoch FROM search.subject_receiver_dirty_v1 d
    WHERE d.registration=reg AND d.change_generation>since ORDER BY change_generation,home LIMIT 1)
  LIMIT 1
$$;


--
-- Name: public_filter_legacy_baseline_interval(integer, text, uuid, integer, integer, text, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_legacy_baseline_interval(owner_partition integer, registration_id text, bootstrap_id uuid, first_home integer, after_home integer, first_root text, final_root text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  -- The original PK admits one row per home. Cardinality proves that the
  -- bounded interval has no holes, including at either endpoint.
  SELECT CASE WHEN first_home BETWEEN 0 AND 4095 AND after_home BETWEEN 1 AND 4096
    AND after_home::bigint-first_home BETWEEN 1 AND 29 THEN (
    SELECT (count(*)=after_home-first_home
      AND bool_and(b.predecessor IS NOT DISTINCT FROM b.expected_predecessor)
      AND max(b.root) FILTER (WHERE b.source_home=after_home-1)=final_root) IS TRUE
    FROM (
      SELECT b.source_home,b.predecessor,b.root,
        lag(b.root,1,first_root) OVER (ORDER BY b.source_home) AS expected_predecessor
      FROM search.public_filter_coverage_baseline b
      WHERE (b.partition_no,b.registration,b.bootstrap)=(owner_partition,registration_id,bootstrap_id)
        AND b.source_home>=first_home AND b.source_home<after_home
    ) b
  ) ELSE false END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: public_filter_coverage_baseline; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_baseline (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    source_home integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    creation_position bigint NOT NULL,
    native_enqueue_revision bigint CONSTRAINT public_filter_coverage_baselin_native_enqueue_revision_not_null NOT NULL,
    native_revision bigint,
    native_claim_revision bigint,
    receipt text NOT NULL,
    predecessor text NOT NULL,
    root text NOT NULL,
    CONSTRAINT public_filter_coverage_baseline_check CHECK (((native_revision IS NULL) = (native_claim_revision IS NULL))),
    CONSTRAINT public_filter_coverage_baseline_check1 CHECK (((native_revision IS NULL) OR ((native_revision > 0) AND (native_claim_revision > 0)))),
    CONSTRAINT public_filter_coverage_baseline_creation_position_check CHECK ((creation_position >= 0)),
    CONSTRAINT public_filter_coverage_baseline_native_enqueue_revision_check CHECK ((native_enqueue_revision >= 0)),
    CONSTRAINT public_filter_coverage_baseline_predecessor_check CHECK ((predecessor ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_coverage_baseline_receipt_check CHECK ((receipt ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_coverage_baseline_root_check CHECK ((root ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_coverage_baseline_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT public_filter_coverage_baseline_source_home_check CHECK (((source_home >= 0) AND (source_home <= 4095))),
    CONSTRAINT public_filter_coverage_baseline_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: public_filter_original_home(integer, text, uuid, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.public_filter_original_home(owner integer, reg text, original uuid, home integer) RETURNS SETOF search.public_filter_coverage_baseline
    LANGUAGE sql STABLE ROWS 1
    AS $$
  SELECT b.* FROM search.public_filter_coverage_baseline b
    WHERE (b.partition_no,b.registration,b.bootstrap,b.source_home)=(owner,reg,original,home)
    AND NOT EXISTS (SELECT FROM core.subject_subscription_v1 s JOIN search.generation_publication j
      ON (j.partition_no,j.job,j.subscription_protocol)=(0,s.job,1) WHERE s.bootstrap=original)
  UNION ALL
  SELECT 0,reg,original,home,(p.cut->>'epoch')::integer,(p.cut->>'privacy')::bigint,(p.cut->>'command')::bigint,
    (p.cut->>'enqueue')::bigint,NULL::bigint,NULL::bigint,p.cut->>'receipt',p.cut->>'predecessor',p.cut->>'root'
    FROM search.subject_receiver_cut_v1(original,home) p WHERE owner=0 AND p.registration=reg
$$;


--
-- Name: receive_subject_privacy_v1(integer, text, bigint, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.receive_subject_privacy_v1(wanted_home integer, wanted_key text, captured bigint, allowance integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: release_relevance_advance(uuid, uuid, uuid, text, text, text, text, integer, text, timestamp with time zone, timestamp with time zone, text[]); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.release_relevance_advance(p_execution_id uuid, p_parent_id uuid, p_proposed_id uuid, p_branch_hash text, p_work_digest text, p_principal text, p_request_hash text, p_generation integer, p_source_cut_hash text, p_expires_at timestamp with time zone, p_now timestamp with time zone, p_work_ids text[]) RETURNS TABLE(execution_id uuid, id uuid, work_digest text)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_execution_id uuid;
  v_parent_root uuid;
  v_root uuid;
  v_existing_id uuid;
  v_existing_digest text;
BEGIN
  SELECT e.id INTO v_execution_id
  FROM search.release_relevance_execution e
  WHERE e.id = p_execution_id
    AND e.principal = p_principal
    AND e.request_hash = p_request_hash
    AND e.generation = p_generation
    AND e.source_cut_hash = p_source_cut_hash
    AND e.expires_at > p_now
    AND EXISTS (
      SELECT 1 FROM search.release_relevance_position p
      WHERE p.execution_id = e.id AND p.id = p_parent_id
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE search.release_relevance_execution e
  SET expires_at = p_expires_at
  WHERE e.id = v_execution_id;
  SELECT p.membership_root INTO v_parent_root
  FROM search.release_relevance_position p
  WHERE p.execution_id = p_execution_id AND p.id = p_parent_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT p.id, p.work_digest INTO v_existing_id, v_existing_digest
  FROM search.release_relevance_position p
  WHERE p.execution_id = p_execution_id
    AND p.parent_id = p_parent_id
    AND p.branch_hash = p_branch_hash;
  IF FOUND THEN
    RETURN QUERY SELECT p_execution_id, v_existing_id, v_existing_digest;
    RETURN;
  END IF;
  IF v_parent_root IS NULL THEN
    RAISE EXCEPTION 'Release relevance membership parent has no root';
  END IF;
  v_root := search.release_relevance_membership_add_many(p_execution_id, v_parent_root, p_work_ids);
  INSERT INTO search.release_relevance_position
    (execution_id, id, parent_id, branch_hash, work_digest, membership_root)
  VALUES (p_execution_id, p_proposed_id, p_parent_id, p_branch_hash, p_work_digest, v_root);
  RETURN QUERY SELECT p_execution_id, p_proposed_id, p_work_digest;
END
$$;


--
-- Name: release_relevance_membership_add(uuid, uuid, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.release_relevance_membership_add(p_execution_id uuid, p_root_id uuid, p_work_id text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_root uuid := p_root_id;
  v_path uuid[] := array_fill(NULL::uuid, ARRAY[33]);
  v_slots integer[] := array_fill(0, ARRAY[32]);
  v_children uuid[];
  v_empty uuid[] := array_fill(NULL::uuid, ARRAY[16]);
  v_key text;
  v_slot integer;
  v_depth integer;
  v_node uuid;
  v_existing text;
BEGIN
  IF v_root IS NULL THEN
    v_root := gen_random_uuid();
    INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
    VALUES (p_execution_id, v_root, 0, v_empty, NULL);
  END IF;

  v_key := encode(uuid_send(p_work_id::uuid), 'hex');
  v_path[1] := v_root;
  FOR v_depth IN 0..31 LOOP
    v_slot := strpos('0123456789abcdef', substring(v_key FROM v_depth + 1 FOR 1));
    v_slots[v_depth + 1] := v_slot;
    IF v_path[v_depth + 1] IS NOT NULL THEN
      SELECT n.children INTO v_children
      FROM search.release_relevance_membership_node n
      WHERE n.execution_id = p_execution_id
        AND n.id = v_path[v_depth + 1]
        AND n.depth = v_depth;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Missing release relevance membership trie node';
      END IF;
      v_path[v_depth + 2] := v_children[v_slot];
    END IF;
  END LOOP;

  IF v_path[33] IS NOT NULL THEN
    SELECT n.work_id INTO v_existing
    FROM search.release_relevance_membership_node n
    WHERE n.execution_id = p_execution_id AND n.id = v_path[33] AND n.depth = 32;
    IF v_existing = p_work_id THEN
      RETURN v_root;
    END IF;
    RAISE EXCEPTION 'Conflicting release relevance membership trie leaf';
  END IF;

  v_node := gen_random_uuid();
  INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
  VALUES (p_execution_id, v_node, 32, v_empty, p_work_id);
  FOR v_depth IN REVERSE 31..0 LOOP
    IF v_path[v_depth + 1] IS NULL THEN
      v_children := v_empty;
    ELSE
      SELECT n.children INTO v_children
      FROM search.release_relevance_membership_node n
      WHERE n.execution_id = p_execution_id
        AND n.id = v_path[v_depth + 1]
        AND n.depth = v_depth;
    END IF;
    v_children[v_slots[v_depth + 1]] := v_node;
    v_node := gen_random_uuid();
    INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
    VALUES (p_execution_id, v_node, v_depth, v_children, NULL);
  END LOOP;
  RETURN v_node;
END
$$;


--
-- Name: release_relevance_membership_add_many(uuid, uuid, text[]); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.release_relevance_membership_add_many(p_execution_id uuid, p_root_id uuid, p_work_ids text[]) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_root uuid := p_root_id;
  v_work_id text;
  v_empty uuid[] := array_fill(NULL::uuid, ARRAY[16]);
BEGIN
  IF v_root IS NULL THEN
    v_root := gen_random_uuid();
    INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
    VALUES (p_execution_id, v_root, 0, v_empty, NULL);
  END IF;
  FOREACH v_work_id IN ARRAY COALESCE(p_work_ids, ARRAY[]::text[]) LOOP
    v_root := search.release_relevance_membership_add(p_execution_id, v_root, v_work_id);
  END LOOP;
  RETURN v_root;
END
$$;


--
-- Name: release_relevance_membership_contains(uuid, uuid, text); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.release_relevance_membership_contains(p_execution_id uuid, p_root_id uuid, p_work_id text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_node uuid := p_root_id;
  v_children uuid[];
  v_key text;
  v_slot integer;
  v_depth integer;
  v_work text;
BEGIN
  IF v_node IS NULL THEN
    RETURN false;
  END IF;
  v_key := encode(uuid_send(p_work_id::uuid), 'hex');
  FOR v_depth IN 0..31 LOOP
    SELECT n.children INTO v_children
    FROM search.release_relevance_membership_node n
    WHERE n.execution_id = p_execution_id AND n.id = v_node AND n.depth = v_depth;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    v_slot := strpos('0123456789abcdef', substring(v_key FROM v_depth + 1 FOR 1));
    v_node := v_children[v_slot];
    IF v_node IS NULL THEN
      RETURN false;
    END IF;
  END LOOP;
  SELECT n.work_id INTO v_work
  FROM search.release_relevance_membership_node n
  WHERE n.execution_id = p_execution_id AND n.id = v_node AND n.depth = 32;
  RETURN COALESCE(v_work = p_work_id, false);
END
$$;


--
-- Name: require_generation_population_batch(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.require_generation_population_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT FROM (SELECT DISTINCT partition_no,registration,build,generation FROM appended
                  WHERE raw_ordinal>=1000 OR output_ordinal>=1000) a
    WHERE NOT EXISTS (SELECT FROM search.public_filter_prepared p
      WHERE (p.partition_no,p.registration,p.build,p.generation)=(a.partition_no,a.registration,a.build,a.generation)
        AND p.population_job IS NOT NULL AND p.state='active' AND p.segment_state='building'
        AND NOT p.raw_exhausted FOR SHARE OF p)
  ) THEN
    RAISE EXCEPTION 'A wide prepared segment requires its original private generation build' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: require_public_filter_ack_live_cut(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.require_public_filter_ack_live_cut() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM FROM search.public_filter_coverage_preparation c
    WHERE (c.partition_no,c.registration,c.bootstrap)=(NEW.partition_no,NEW.registration,NEW.bootstrap)
      AND c.ack_protocol=1 AND NOT c.ack_retired FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original receiver ACK cut has retired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: require_subject_receiver_format_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.require_subject_receiver_format_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: require_subject_receiver_prefix_v1(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.require_subject_receiver_prefix_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: reset_deleted_freshness_points(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.reset_deleted_freshness_points() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM removed) THEN
    UPDATE search.freshness_observation_reset SET revision = gen_random_uuid() WHERE singleton;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: reset_freshness_observation(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.reset_freshness_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE search.freshness_observation_reset SET revision = gen_random_uuid() WHERE singleton;
  RETURN NULL;
END;
$$;


--
-- Name: retain_pending_freshness_home(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.retain_pending_freshness_home() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE home integer := coalesce(NEW.partition_no,OLD.partition_no);
BEGIN
  IF TG_OP='UPDATE' AND OLD.position=NEW.position THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' AND NEW.position=0 THEN RETURN NULL; END IF;
  INSERT INTO search.freshness_positions(consumer,shard,positions,pending)
    VALUES ('',home,CASE WHEN NEW.position>0 THEN jsonb_build_object(home,NEW.position) ELSE '{}'::jsonb END,true)
    ON CONFLICT (consumer,shard) DO UPDATE SET positions=EXCLUDED.positions,pending=true;
  RETURN NULL;
END;
$$;


--
-- Name: retain_public_filter_ack_protocol(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.retain_public_filter_ack_protocol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT FROM semantic.public_filter_bootstrap b WHERE (b.partition_no,b.bootstrap)=(0,OLD.bootstrap)
    AND b.state<>'aborted') THEN
    RAISE EXCEPTION 'An original live preparation retains its ACK protocol' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;


--
-- Name: retain_public_filter_coverage_baseline(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.retain_public_filter_coverage_baseline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Original coverage baseline is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_population_protocol(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.retain_public_filter_population_protocol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.population_protocol IS DISTINCT FROM OLD.population_protocol THEN
    RAISE EXCEPTION 'Original population protocol is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retire_public_filter_ack_manifest(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.retire_public_filter_ack_manifest() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM FROM search.public_filter_observation o
    WHERE (o.partition_no,o.observation)=(OLD.partition_no,OLD.observation)
      AND o.state IN ('closing','closed') FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT FROM search.public_filter_reference f
    WHERE (f.partition_no,f.observation)=(OLD.partition_no,OLD.observation))
    OR EXISTS (SELECT FROM search.public_filter_pit p
      WHERE (p.partition_no,p.observation)=(OLD.partition_no,OLD.observation)) THEN
    RAISE EXCEPTION 'Original receiver manifest still has observation custody' USING ERRCODE='23514';
  END IF;
  UPDATE search.public_filter_coverage_preparation SET ack_retired=true
    WHERE (partition_no,registration,bootstrap)=(OLD.partition_no,OLD.registration,OLD.bootstrap);
  RETURN OLD;
END $$;


--
-- Name: shared_subject_job_v1(uuid); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.shared_subject_job_v1(wanted uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (SELECT FROM search.generation_publication WHERE (partition_no,job,subscription_protocol)=(0,wanted,1))
$$;


--
-- Name: subject_ack_windows_v1(text, integer, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.subject_ack_windows_v1(step_state text, lo integer, hi integer) RETURNS TABLE(home integer, epoch integer, base bigint, through_pos bigint, receipt text, member text)
    LANGUAGE plpgsql STABLE STRICT
    AS $$
DECLARE body jsonb:=step_state::jsonb->1; input jsonb:=search.public_filter_ack_field(body,'input');
  batch jsonb; ends jsonb; packed bytea; first_no integer; members integer; idx integer;
BEGIN
  IF lo<0 OR hi>4096 OR hi-lo NOT BETWEEN 1 AND 32 THEN RETURN; END IF;
  member:=search.public_filter_ack_field(input,'heldBirth')#>>'{}';
  IF search.public_filter_ack_field(input,'phase')='"window"' OR
    (search.public_filter_ack_field(input,'phase')='"scan"' AND
     search.public_filter_ack_field(input,'heldPageStart')=search.public_filter_ack_field(input,'partition') AND
     search.public_filter_ack_field(body,'scan') IS NOT NULL) THEN
    batch:=search.public_filter_ack_field(body,'windowBatch');
    first_no:=search.public_filter_ack_field(batch,'from')::integer;
    members:=search.public_filter_ack_field(batch,'count')::integer;
    IF search.public_filter_ack_field(batch,'originalCuts')='true' THEN
      IF (members BETWEEN 32 AND 512 AND lo>=first_no AND hi<=first_no+members) IS NOT TRUE THEN RETURN; END IF;
      ends:=(search.public_filter_ack_field(batch,'commandEnds')#>>'{}')::jsonb;
      RETURN QUERY SELECT i,(cut->>'epoch')::integer,(cut->>'command')::bigint,
        coalesce((ends->>i::text)::bigint,(cut->>'command')::bigint),cut->>'receipt',member
        FROM generate_series(lo,hi-1) i CROSS JOIN LATERAL (
          SELECT p.cuts->(i-p.first_home) AS cut FROM semantic.subject_access_page_v1 p
          WHERE (p.birth,p.first_home,p.end_home)=(member::bigint,i/32*32,i/32*32+32) LIMIT 1) x ORDER BY i;
      RETURN;
    END IF;
    packed:=decode(search.public_filter_ack_field(batch,'packed')#>>'{}','base64');
    ends:=search.public_filter_ack_field(batch,'through');
    IF (members BETWEEN 1 AND 128 AND lo>=first_no AND hi<=first_no+members AND
        length(packed)=44*members) IS NOT TRUE THEN RETURN; END IF;
    FOR idx IN lo-first_no..hi-first_no-1 LOOP
      home:=first_no+idx;
      epoch:=('x'||encode(substring(packed FROM 44*idx+1 FOR 4),'hex'))::bit(32)::integer;
      base:=('x'||encode(substring(packed FROM 44*idx+5 FOR 8),'hex'))::bit(64)::bigint;
      through_pos:=CASE WHEN ends IS NULL THEN base ELSE (ends->idx->>1)::bigint END;
      receipt:=encode(substring(packed FROM 44*idx+13 FOR 32),'hex');
      IF epoch>0 AND base>=0 AND through_pos>=base THEN RETURN NEXT; END IF;
    END LOOP;
  ELSIF hi=lo+1 THEN
    RETURN QUERY SELECT lo,w.epoch,w.base,w.through_pos,w.receipt,member FROM search.public_filter_ack_window(step_state,lo) w;
  END IF;
END $$;


--
-- Name: subject_compact_window_v1(uuid, text, text, bigint, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.subject_compact_window_v1(original uuid, run text, chain text, member bigint, lo integer) RETURNS TABLE(stop integer, root text)
    LANGUAGE sql STABLE
    AS $$
  WITH step AS MATERIALIZED (
    SELECT s.verified_home,s.verified_root,s.state::jsonb->1 AS body FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,original,run,chain)
      AND s.verified_home<=lo AND s.verified_root IS NOT NULL AND NOT s.complete
    ORDER BY s.verified_home DESC LIMIT 1
  )
  SELECT s.verified_home+n,s.verified_root FROM step s
    CROSS JOIN LATERAL (SELECT search.public_filter_ack_field(body,'windowBatch') AS batch,
      search.public_filter_ack_field(body,'input') AS input) b
    CROSS JOIN LATERAL (SELECT search.public_filter_ack_field(batch,'count')::integer AS n) size
    WHERE search.public_filter_ack_field(batch,'originalCuts')='true'
      AND search.public_filter_ack_field(batch,'from')::integer=s.verified_home
      AND search.public_filter_ack_field(input,'heldBirth')#>>'{}'=member::text
      AND n BETWEEN 32 AND 512 AND lo<s.verified_home+n
$$;


--
-- Name: subject_original_physical_homes_v1(uuid, integer, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.subject_original_physical_homes_v1(job_id uuid, lo integer, hi integer) RETURNS TABLE(home integer, epoch integer, command_base bigint)
    LANGUAGE sql STABLE
    AS $$
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


--
-- Name: subject_receiver_cut_v1(uuid, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.subject_receiver_cut_v1(original uuid, home integer) RETURNS TABLE(birth bigint, registration text, cut jsonb)
    LANGUAGE sql STABLE ROWS 1
    AS $$
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


--
-- Name: truncate_freshness_groups(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.truncate_freshness_groups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM search.freshness_positions WHERE (consumer='')=(TG_TABLE_NAME='partition');
  DELETE FROM search.freshness_groups WHERE (consumer='')=(TG_TABLE_NAME='partition');
  RETURN NULL;
END;
$$;


--
-- Name: truncate_freshness_positions(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.truncate_freshness_positions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM search.freshness_positions WHERE (consumer = '') = (TG_TABLE_NAME = 'partition');
  RETURN NULL;
END;
$$;


--
-- Name: verified_subject_page_v1(bigint, integer, integer); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.verified_subject_page_v1(member bigint, lo integer, hi integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE original jsonb;
BEGIN
  SELECT p.cuts INTO STRICT original FROM semantic.subject_access_page_v1 p JOIN core.subject_retention_page_v1 c
    ON (c.birth,c.first_home,c.end_home)=(p.birth,p.first_home,p.end_home)
    WHERE (p.birth,p.first_home,p.end_home)=(member,lo,hi) AND p.captured_xid<>pg_current_xact_id();
  IF semantic.capture_subject_access_page_v1(member,lo,hi) IS DISTINCT FROM original THEN
    RAISE EXCEPTION 'Original Subject page changed' USING ERRCODE='40001'; END IF;
  RETURN original;
END $$;


--
-- Name: write_freshness_slot(text, integer, bigint); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.write_freshness_slot(who text, home integer, value bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE emptied boolean;
BEGIN
  IF value>0 THEN
    INSERT INTO search.freshness_groups AS g (consumer,shard,positions)
      VALUES (who,home / 64,jsonb_build_object(home,value))
      ON CONFLICT (consumer,shard) DO UPDATE SET positions=g.positions || EXCLUDED.positions;
  ELSE
    UPDATE search.freshness_groups SET positions=positions-home::text
      WHERE consumer=who AND shard=home / 64 RETURNING positions='{}'::jsonb INTO emptied;
    IF emptied THEN DELETE FROM search.freshness_groups WHERE consumer=who AND shard=home / 64; END IF;
  END IF;
END;
$$;


--
-- Name: public_filter_coverage_home; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_home (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    source_home integer NOT NULL,
    source_epoch integer NOT NULL,
    relevant_position bigint NOT NULL,
    acknowledged_position bigint DEFAULT 0 NOT NULL,
    native_enqueue_revision bigint DEFAULT 0 NOT NULL,
    native_revision bigint,
    native_claim_revision bigint,
    acknowledged_native_revision bigint,
    acknowledged_native_claim_revision bigint,
    last_change_generation bigint NOT NULL,
    behind boolean DEFAULT true NOT NULL,
    acknowledged_native_enqueue bigint DEFAULT 0 CONSTRAINT public_filter_coverage_home_acknowledged_native_enqueu_not_null NOT NULL,
    baseline_bootstrap uuid,
    acknowledged_baseline uuid,
    acknowledged_observation text,
    acknowledged_execution text,
    acknowledged_settlement text,
    baseline_delta boolean,
    CONSTRAINT public_filter_coverage_ack_receipt CHECK ((((acknowledged_observation IS NULL) = (acknowledged_execution IS NULL)) AND ((acknowledged_execution IS NULL) = (acknowledged_settlement IS NULL)) AND ((acknowledged_settlement IS NULL) OR (acknowledged_baseline IS NOT NULL)))),
    CONSTRAINT public_filter_coverage_home_ack_prefix CHECK ((behind OR ((baseline_bootstrap IS NOT NULL) AND (acknowledged_baseline IS NOT NULL) AND (acknowledged_baseline = baseline_bootstrap) AND (acknowledged_position >= relevant_position) AND (acknowledged_native_enqueue >= native_enqueue_revision) AND ((native_revision IS NULL) OR ((acknowledged_native_revision IS NOT NULL) AND (acknowledged_native_revision >= native_revision))) AND ((native_claim_revision IS NULL) OR ((acknowledged_native_claim_revision IS NOT NULL) AND (acknowledged_native_claim_revision >= native_claim_revision)))))),
    CONSTRAINT public_filter_coverage_home_acknowledged_execution_check CHECK (((octet_length(acknowledged_execution) >= 1) AND (octet_length(acknowledged_execution) <= 4096))),
    CONSTRAINT public_filter_coverage_home_acknowledged_native_enqueue_check CHECK ((acknowledged_native_enqueue >= 0)),
    CONSTRAINT public_filter_coverage_home_acknowledged_observation_check CHECK (((octet_length(acknowledged_observation) >= 1) AND (octet_length(acknowledged_observation) <= 4096))),
    CONSTRAINT public_filter_coverage_home_acknowledged_position_check CHECK ((acknowledged_position >= 0)),
    CONSTRAINT public_filter_coverage_home_acknowledged_settlement_check CHECK (((octet_length(acknowledged_settlement) >= 1) AND (octet_length(acknowledged_settlement) <= 4096))),
    CONSTRAINT public_filter_coverage_home_last_change_generation_check CHECK ((last_change_generation >= 0)),
    CONSTRAINT public_filter_coverage_home_native_enqueue_revision_check CHECK ((native_enqueue_revision >= 0)),
    CONSTRAINT public_filter_coverage_home_relevant_position_check CHECK ((relevant_position >= 0)),
    CONSTRAINT public_filter_coverage_home_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT public_filter_coverage_home_source_home_check CHECK (((source_home >= 0) AND (source_home <= 4095)))
);


--
-- Name: discovery_copy; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_copy (
    route integer NOT NULL,
    source_id uuid NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    kind text NOT NULL COLLATE pg_catalog."C",
    "position" bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    settled boolean DEFAULT false NOT NULL,
    CONSTRAINT discovery_copy_check CHECK ((route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT discovery_copy_position_check CHECK (("position" >= 0)),
    CONSTRAINT discovery_copy_revision_check CHECK ((revision >= 0)),
    CONSTRAINT discovery_copy_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: discovery_erasure; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_erasure (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    CONSTRAINT discovery_erasure_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))))
);


--
-- Name: discovery_generation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_generation (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    index_uuid text COLLATE pg_catalog."C",
    incarnation uuid NOT NULL,
    kinds text[] NOT NULL,
    state text NOT NULL,
    activated_at timestamp with time zone,
    capability jsonb,
    CONSTRAINT discovery_generation_generation_check CHECK ((generation > 0)),
    CONSTRAINT discovery_generation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT discovery_generation_state_check CHECK ((state = ANY (ARRAY['allocated'::text, 'populating'::text, 'replaying'::text, 'reconciling'::text, 'ready'::text, 'active'::text, 'retiring'::text, 'retired'::text, 'quarantined'::text])))
);


--
-- Name: discovery_population; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_population (
    partition_no integer NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    owner text NOT NULL,
    after_route integer,
    after_id uuid,
    complete boolean DEFAULT false NOT NULL,
    certified boolean DEFAULT false NOT NULL,
    indexed bigint DEFAULT 0 NOT NULL,
    census bigint DEFAULT 0 NOT NULL,
    reconcile_position bigint,
    "position" bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    claim_revision bigint DEFAULT 0 NOT NULL,
    continuation jsonb,
    native_complete boolean DEFAULT false NOT NULL,
    native_epoch integer,
    CONSTRAINT discovery_population_check CHECK (((after_route IS NULL) = (after_id IS NULL))),
    CONSTRAINT discovery_population_check1 CHECK (((after_route IS NULL) OR ((after_route / 16) = partition_no))),
    CONSTRAINT discovery_population_claim_revision_check CHECK ((claim_revision >= 0)),
    CONSTRAINT discovery_population_owner_check CHECK ((owner = ANY (ARRAY['accounts'::text, 'semantic'::text, 'collection'::text, 'review'::text, 'space'::text]))),
    CONSTRAINT discovery_population_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT discovery_population_position_check CHECK (("position" >= 0)),
    CONSTRAINT discovery_population_revision_check CHECK ((revision >= 0))
);


--
-- Name: erasure_effect; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.erasure_effect (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL COLLATE pg_catalog."C",
    job uuid DEFAULT gen_random_uuid() NOT NULL,
    source_basis text NOT NULL,
    consumer jsonb NOT NULL,
    barrier jsonb NOT NULL,
    native_revision text NOT NULL,
    record_key text,
    key_offset integer DEFAULT 0 NOT NULL,
    fence text,
    phase text DEFAULT 'repair'::text NOT NULL,
    CONSTRAINT erasure_effect_barrier_check CHECK ((octet_length((barrier)::text) <= 4096)),
    CONSTRAINT erasure_effect_consumer_check CHECK ((octet_length((consumer)::text) <= 8192)),
    CONSTRAINT erasure_effect_fence_check CHECK ((octet_length(fence) <= 4096)),
    CONSTRAINT erasure_effect_key_offset_check CHECK ((key_offset >= 0)),
    CONSTRAINT erasure_effect_phase_check CHECK ((phase = ANY (ARRAY['repair'::text, 'fence'::text, 'drain'::text, 'adopt'::text, 'compact'::text, 'settled'::text, 'released'::text]))),
    CONSTRAINT erasure_effect_record_key_check CHECK ((octet_length(record_key) <= 4096)),
    CONSTRAINT erasure_effect_source_basis_check CHECK ((octet_length(source_basis) <= 4096))
);


--
-- Name: erasure_progress; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.erasure_progress (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    protocol integer NOT NULL,
    phase text NOT NULL,
    pending_reason text,
    ever_applied boolean DEFAULT false NOT NULL,
    frontier text,
    source_complete boolean DEFAULT false NOT NULL,
    personal_complete boolean DEFAULT false NOT NULL,
    acked boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT erasure_progress_frontier_check CHECK ((octet_length(frontier) <= 2048)),
    CONSTRAINT erasure_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT erasure_progress_phase_check CHECK ((phase = ANY (ARRAY['sealing'::text, 'source'::text, 'copies'::text, 'repair'::text, 'drain'::text, 'finalize'::text, 'done'::text]))),
    CONSTRAINT erasure_progress_protocol_check CHECK ((protocol = 1)),
    CONSTRAINT erasure_progress_version_check CHECK ((version = 1))
);


--
-- Name: erasure_target; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.erasure_target (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    copy_home integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL COLLATE pg_catalog."C",
    copy_revision bigint NOT NULL,
    registration_after text COLLATE pg_catalog."C",
    copies_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT erasure_target_copy_home_check CHECK (((copy_home >= 0) AND (copy_home <= 4095)))
);


--
-- Name: facet_generation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.facet_generation (
    partition_no integer NOT NULL,
    definition text NOT NULL COLLATE pg_catalog."C",
    generation text NOT NULL COLLATE pg_catalog."C",
    property text NOT NULL,
    observation text NOT NULL,
    state text NOT NULL,
    phase text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    lease_until bigint DEFAULT 0 NOT NULL,
    expires_at bigint NOT NULL,
    frontier text,
    population_complete boolean DEFAULT false NOT NULL,
    subject text,
    terminal text,
    subject_type text,
    security_revision text,
    projection jsonb,
    accumulator jsonb DEFAULT '[]'::jsonb NOT NULL,
    contribution_after text COLLATE pg_catalog."C",
    as_of text,
    CONSTRAINT facet_generation_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT facet_generation_phase_check CHECK ((phase = ANY (ARRAY['population'::text, 'projection'::text, 'contribute'::text, 'seal'::text]))),
    CONSTRAINT facet_generation_state_check CHECK ((state = ANY (ARRAY['building'::text, 'ready'::text, 'retired'::text])))
);


--
-- Name: facet_stage; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.facet_stage (
    partition_no integer NOT NULL,
    definition text NOT NULL COLLATE pg_catalog."C",
    generation text NOT NULL COLLATE pg_catalog."C",
    subject text NOT NULL COLLATE pg_catalog."C",
    key text NOT NULL COLLATE pg_catalog."C",
    value text NOT NULL COLLATE pg_catalog."C",
    labels jsonb NOT NULL,
    target_original text,
    target_terminal text
);


--
-- Name: facet_value; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.facet_value (
    partition_no integer NOT NULL,
    definition text NOT NULL COLLATE pg_catalog."C",
    generation text NOT NULL COLLATE pg_catalog."C",
    value text NOT NULL COLLATE pg_catalog."C",
    labels jsonb NOT NULL,
    contributor_original text NOT NULL,
    contributor_terminal text NOT NULL,
    target_original text,
    target_terminal text
);


--
-- Name: freshness_groups; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.freshness_groups (
    consumer text CONSTRAINT freshness_positions_consumer_not_null NOT NULL,
    shard integer CONSTRAINT freshness_positions_shard_not_null NOT NULL,
    positions jsonb CONSTRAINT freshness_positions_positions_not_null NOT NULL,
    CONSTRAINT freshness_positions_consumer_check CHECK (((consumer = ''::text) OR starts_with(consumer, 'search_'::text))),
    CONSTRAINT freshness_positions_positions_check CHECK ((jsonb_typeof(positions) = 'object'::text)),
    CONSTRAINT freshness_positions_shard_check CHECK ((shard >= 0))
);


--
-- Name: freshness_home; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.freshness_home (
    partition_no integer NOT NULL,
    head bigint DEFAULT 0 NOT NULL,
    checkpoint_ceiling bigint DEFAULT 0 NOT NULL,
    "position" bigint GENERATED ALWAYS AS (
CASE
    WHEN (head > checkpoint_ceiling) THEN (checkpoint_ceiling + 1)
    ELSE head
END) STORED,
    CONSTRAINT freshness_home_checkpoint_ceiling_check CHECK ((checkpoint_ceiling >= 0)),
    CONSTRAINT freshness_home_head_check CHECK ((head >= 0)),
    CONSTRAINT freshness_home_partition_no_check CHECK ((partition_no >= 0))
);


--
-- Name: freshness_observation_reset; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.freshness_observation_reset (
    singleton boolean NOT NULL,
    revision uuid NOT NULL,
    CONSTRAINT freshness_observation_reset_singleton_check CHECK (singleton)
);


--
-- Name: freshness_positions; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.freshness_positions (
    consumer text NOT NULL,
    shard integer NOT NULL,
    positions jsonb NOT NULL,
    pending boolean DEFAULT false NOT NULL,
    change_xid xid8,
    CONSTRAINT freshness_positions_consumer_check CHECK (((consumer = ''::text) OR starts_with(consumer, 'search_'::text))),
    CONSTRAINT freshness_positions_positions_check CHECK ((jsonb_typeof(positions) = 'object'::text)),
    CONSTRAINT freshness_positions_shard_check CHECK ((shard >= 0))
);


--
-- Name: generation_publication; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.generation_publication (
    partition_no integer DEFAULT 0 NOT NULL,
    job uuid NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    consumer jsonb NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    family text NOT NULL,
    native_incarnation text NOT NULL,
    pass bigint DEFAULT 1 NOT NULL,
    activated_at text NOT NULL,
    kinds text[] NOT NULL,
    source_home integer NOT NULL,
    binding jsonb NOT NULL,
    phase text DEFAULT 'subject'::text NOT NULL,
    home integer DEFAULT 0 NOT NULL,
    after_route integer,
    after_id uuid,
    engine_after jsonb,
    pit text,
    fence text,
    fenced_pass boolean DEFAULT false NOT NULL,
    observation text,
    previous_target text,
    previous_uuid text,
    revision bigint DEFAULT 1 NOT NULL,
    bootstrap text,
    queried text,
    execution text,
    ack_protocol smallint DEFAULT 0 NOT NULL,
    subscription_protocol smallint DEFAULT 0 NOT NULL,
    subject_fenced_cut bytea,
    CONSTRAINT generation_publication_binding_check CHECK ((octet_length((binding)::text) <= 8192)),
    CONSTRAINT generation_publication_bootstrap_check CHECK (((octet_length(bootstrap) >= 1) AND (octet_length(bootstrap) <= 4096))),
    CONSTRAINT generation_publication_check CHECK (((after_route IS NULL) = (after_id IS NULL))),
    CONSTRAINT generation_publication_check1 CHECK (((ack_protocol = 0) OR ((ack_protocol = 1) AND (family = 'subjects'::text) AND (source_home = 0)))),
    CONSTRAINT generation_publication_check2 CHECK (((subscription_protocol = 0) OR ((subscription_protocol = 1) AND (ack_protocol = 1) AND (family = 'subjects'::text) AND (source_home = 0)))),
    CONSTRAINT generation_publication_consumer_check CHECK ((octet_length((consumer)::text) <= 8192)),
    CONSTRAINT generation_publication_engine_after_check CHECK ((octet_length((engine_after)::text) <= 8192)),
    CONSTRAINT generation_publication_execution_check CHECK (((octet_length(execution) >= 1) AND (octet_length(execution) <= 4096))),
    CONSTRAINT generation_publication_family_check CHECK ((family = ANY (ARRAY['subjects'::text, 'discovery'::text]))),
    CONSTRAINT generation_publication_fence_check CHECK ((octet_length(fence) <= 8192)),
    CONSTRAINT generation_publication_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT generation_publication_home_check CHECK (((home >= 0) AND (home <= 4096))),
    CONSTRAINT generation_publication_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT generation_publication_pass_check CHECK ((pass > 0)),
    CONSTRAINT generation_publication_phase_check CHECK ((phase = ANY (ARRAY['subject'::text, 'account'::text, 'engine'::text, 'validate'::text, 'reconciled'::text, 'fencing'::text, 'intent'::text, 'active'::text]))),
    CONSTRAINT generation_publication_pin_shape CHECK ((((bootstrap IS NULL) = (queried IS NULL)) AND ((queried IS NULL) = (execution IS NULL)))),
    CONSTRAINT generation_publication_pit_check CHECK ((octet_length(pit) <= 65536)),
    CONSTRAINT generation_publication_queried_check CHECK (((octet_length(queried) >= 1) AND (octet_length(queried) <= 262144))),
    CONSTRAINT generation_publication_revision_check CHECK ((revision > 0)),
    CONSTRAINT generation_publication_source_home_check CHECK (((source_home >= 0) AND (source_home <= 4095))),
    CONSTRAINT generation_publication_subject_fenced_cut_check CHECK ((octet_length(subject_fenced_cut) = 32))
);


--
-- Name: generation_publication_home; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.generation_publication_home (
    partition_no integer NOT NULL,
    job uuid NOT NULL,
    pass bigint NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    account_revision bigint DEFAULT 0 NOT NULL,
    claim_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT generation_publication_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT generation_publication_home_pass_check CHECK ((pass > 0)),
    CONSTRAINT generation_publication_home_position_check CHECK (("position" >= 0))
);


--
-- Name: generation_publication_lock; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.generation_publication_lock (
    physical_target text NOT NULL COLLATE pg_catalog."C",
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT generation_publication_lock_physical_target_check CHECK (((octet_length(physical_target) >= 1) AND (octet_length(physical_target) <= 255))),
    CONSTRAINT generation_publication_lock_revision_check CHECK ((revision >= 0))
);


--
-- Name: grouped_freshness_positions; Type: VIEW; Schema: search; Owner: -
--

CREATE VIEW search.grouped_freshness_positions AS
 WITH edits AS (
         SELECT (freshness_positions.shard / 64) AS shard,
            jsonb_object_agg(freshness_positions.shard, (freshness_positions.positions -> (freshness_positions.shard)::text)) FILTER (WHERE (freshness_positions.positions <> '{}'::jsonb)) AS added,
            array_agg((freshness_positions.shard)::text) FILTER (WHERE (freshness_positions.positions = '{}'::jsonb)) AS removed
           FROM search.freshness_positions
          WHERE ((freshness_positions.consumer = ''::text) AND freshness_positions.pending)
          GROUP BY (freshness_positions.shard / 64)
        )
 SELECT g.consumer,
    g.shard,
        CASE
            WHEN (e.shard IS NULL) THEN g.positions
            ELSE ((g.positions || COALESCE(e.added, '{}'::jsonb)) - COALESCE(e.removed, '{}'::text[]))
        END AS positions
   FROM (search.freshness_groups g
     LEFT JOIN edits e ON (((g.consumer = ''::text) AND (e.shard = g.shard))))
  WHERE ((e.removed IS NULL) OR (((g.positions || COALESCE(e.added, '{}'::jsonb)) - e.removed) <> '{}'::jsonb))
UNION ALL
 SELECT ''::text AS consumer,
    e.shard,
    e.added AS positions
   FROM edits e
  WHERE ((e.added IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM search.freshness_groups g
          WHERE ((g.consumer = ''::text) AND (g.shard = e.shard))))));


--
-- Name: identity_receiving_native_copy; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_copy (
    partition_no integer NOT NULL,
    plan_id uuid NOT NULL,
    copy_no integer NOT NULL,
    locator jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    reconciled_transaction_id uuid,
    settlement jsonb,
    CONSTRAINT identity_receiving_native_copy_check CHECK (((reconciled_transaction_id IS NULL) = (settlement IS NULL))),
    CONSTRAINT identity_receiving_native_copy_copy_no_check CHECK ((copy_no >= 0)),
    CONSTRAINT identity_receiving_native_copy_locator_check CHECK ((octet_length((locator)::text) <= 2048)),
    CONSTRAINT identity_receiving_native_copy_settlement_check CHECK ((octet_length((settlement)::text) <= 512))
);


--
-- Name: identity_receiving_native_document; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_document (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    document_id uuid NOT NULL,
    CONSTRAINT identity_receiving_native_document_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_receiving_native_hold; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_hold (
    partition_no integer NOT NULL,
    plan_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    accepted_transaction_id uuid NOT NULL,
    accepted_epoch integer,
    accepted_position bigint,
    released_transaction_id uuid,
    CONSTRAINT identity_receiving_native_hold_accepted_epoch_check CHECK ((accepted_epoch > 0)),
    CONSTRAINT identity_receiving_native_hold_accepted_position_check CHECK ((accepted_position > 0)),
    CONSTRAINT identity_receiving_native_hold_check CHECK (((accepted_epoch IS NULL) = (accepted_position IS NULL)))
);


--
-- Name: identity_receiving_native_operation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_operation (
    partition_no integer NOT NULL,
    plan_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    state text NOT NULL,
    writer_token uuid NOT NULL,
    writer_locator text NOT NULL,
    writer_transaction_id uuid CONSTRAINT identity_receiving_native_operat_writer_transaction_id_not_null NOT NULL,
    writer_position bigint NOT NULL,
    dispatch_transaction_id uuid CONSTRAINT identity_receiving_native_oper_dispatch_transaction_id_not_null NOT NULL,
    visible_transaction_id uuid,
    visible_position bigint,
    writer_evidence_digest text,
    applied_transaction_id uuid,
    frontier jsonb,
    CONSTRAINT identity_receiving_native_operatio_writer_evidence_digest_check CHECK ((writer_evidence_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT identity_receiving_native_operation_check CHECK (((state = 'dispatched'::text) = (visible_transaction_id IS NULL))),
    CONSTRAINT identity_receiving_native_operation_check1 CHECK (((visible_transaction_id IS NULL) = (visible_position IS NULL))),
    CONSTRAINT identity_receiving_native_operation_check2 CHECK (((visible_transaction_id IS NULL) = (writer_evidence_digest IS NULL))),
    CONSTRAINT identity_receiving_native_operation_check3 CHECK (((state = 'applied'::text) = (applied_transaction_id IS NOT NULL))),
    CONSTRAINT identity_receiving_native_operation_check4 CHECK (((applied_transaction_id IS NULL) = (frontier IS NULL))),
    CONSTRAINT identity_receiving_native_operation_frontier_check CHECK ((octet_length((frontier)::text) <= 2048)),
    CONSTRAINT identity_receiving_native_operation_state_check CHECK ((state = ANY (ARRAY['dispatched'::text, 'visible'::text, 'applied'::text]))),
    CONSTRAINT identity_receiving_native_operation_visible_position_check CHECK ((visible_position > 0)),
    CONSTRAINT identity_receiving_native_operation_writer_locator_check CHECK (((octet_length(writer_locator) >= 1) AND (octet_length(writer_locator) <= 8192))),
    CONSTRAINT identity_receiving_native_operation_writer_position_check CHECK ((writer_position > 0))
);


--
-- Name: identity_receiving_native_pending; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_pending (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    plan_id uuid NOT NULL
);


--
-- Name: identity_receiving_native_plan; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_plan (
    partition_no integer NOT NULL,
    plan_id uuid NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    original_id uuid NOT NULL,
    document_id uuid NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    effect_key text NOT NULL COLLATE pg_catalog."C",
    scope_digest text NOT NULL,
    source jsonb NOT NULL,
    obligations jsonb NOT NULL,
    action_digest text NOT NULL,
    initial_copy_count integer NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_receiving_native_plan_action_digest_check CHECK ((action_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT identity_receiving_native_plan_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT identity_receiving_native_plan_initial_copy_count_check CHECK (((initial_copy_count >= 0) AND (initial_copy_count <= 100))),
    CONSTRAINT identity_receiving_native_plan_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_receiving_native_plan_obligations_check CHECK ((octet_length((obligations)::text) <= 8192)),
    CONSTRAINT identity_receiving_native_plan_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_receiving_native_plan_physical_target_check CHECK ((octet_length(physical_target) <= 256)),
    CONSTRAINT identity_receiving_native_plan_scope_digest_check CHECK ((scope_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT identity_receiving_native_plan_source_check CHECK ((octet_length((source)::text) <= 8192))
);


--
-- Name: identity_receiving_native_scope_pending; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_receiving_native_scope_pending (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    effect_key text NOT NULL COLLATE pg_catalog."C",
    plan_transaction_id uuid CONSTRAINT identity_receiving_native_scope_pe_plan_transaction_id_not_null NOT NULL,
    CONSTRAINT identity_receiving_native_scope_pending_job_epoch_check CHECK ((job_epoch > 0))
);


--
-- Name: identity_writer; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_writer (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    original_id uuid NOT NULL,
    incarnation text NOT NULL,
    owner_epoch integer NOT NULL,
    writer_token uuid,
    writer_transaction_id uuid,
    writer_position bigint,
    settled_transaction_id uuid,
    settled_position bigint,
    source_position bigint,
    closed_job uuid,
    closed_epoch bigint,
    closed_transaction_id uuid,
    closed_position bigint,
    dispatch_state text DEFAULT 'enrolled'::text NOT NULL,
    visible_transaction_id uuid,
    visible_position bigint,
    repair_locator text,
    repair_action text,
    repair_receipt text,
    repair_account text,
    relay_receipt text,
    relay_intent text,
    relay_rejected_action text,
    CONSTRAINT identity_writer_check CHECK (((writer_transaction_id IS NULL) = (writer_position IS NULL))),
    CONSTRAINT identity_writer_check1 CHECK (((writer_token IS NULL) OR (writer_transaction_id IS NOT NULL))),
    CONSTRAINT identity_writer_check2 CHECK (((settled_transaction_id IS NULL) = (settled_position IS NULL))),
    CONSTRAINT identity_writer_check3 CHECK (((closed_job IS NULL) = (closed_epoch IS NULL))),
    CONSTRAINT identity_writer_check4 CHECK (((closed_job IS NULL) = (closed_transaction_id IS NULL))),
    CONSTRAINT identity_writer_check5 CHECK (((closed_job IS NULL) = (closed_position IS NULL))),
    CONSTRAINT identity_writer_check6 CHECK (((visible_transaction_id IS NULL) = (visible_position IS NULL))),
    CONSTRAINT identity_writer_closed_epoch_check CHECK ((closed_epoch > 0)),
    CONSTRAINT identity_writer_closed_position_check CHECK ((closed_position > 0)),
    CONSTRAINT identity_writer_dispatch_state_check CHECK ((dispatch_state = ANY (ARRAY['enrolled'::text, 'dispatched'::text, 'settled'::text, 'cancelled'::text]))),
    CONSTRAINT identity_writer_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT identity_writer_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_writer_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_writer_physical_target_check CHECK (((octet_length(physical_target) >= 1) AND (octet_length(physical_target) <= 255))),
    CONSTRAINT identity_writer_rejected_action_check CHECK (((relay_rejected_action IS NULL) OR ((dispatch_state = 'dispatched'::text) AND (writer_token IS NOT NULL) AND (relay_intent IS NOT NULL) AND (relay_receipt IS NULL)))),
    CONSTRAINT identity_writer_relay_intent_check CHECK (((relay_intent IS NULL) OR ((dispatch_state = 'dispatched'::text) AND (writer_token IS NOT NULL) AND (octet_length(relay_intent) <= 82)))),
    CONSTRAINT identity_writer_relay_receipt_check CHECK (((relay_receipt IS NULL) OR ((dispatch_state = 'dispatched'::text) AND (writer_token IS NOT NULL) AND (octet_length(relay_receipt) <= 8192)))),
    CONSTRAINT identity_writer_repair_account_check CHECK ((octet_length(repair_account) <= 65536)),
    CONSTRAINT identity_writer_repair_action_check CHECK ((octet_length(repair_action) <= 1048576)),
    CONSTRAINT identity_writer_repair_locator_check CHECK ((octet_length(repair_locator) <= 8192)),
    CONSTRAINT identity_writer_repair_receipt_check CHECK ((octet_length(repair_receipt) <= 1048576)),
    CONSTRAINT identity_writer_settled_position_check CHECK ((settled_position > 0)),
    CONSTRAINT identity_writer_source_position_check CHECK ((source_position >= 0)),
    CONSTRAINT identity_writer_visible_position_check CHECK ((visible_position > 0)),
    CONSTRAINT identity_writer_writer_position_check CHECK ((writer_position > 0))
);


--
-- Name: identity_writer_gate; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_writer_gate (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    consumer text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL,
    write_alias text NOT NULL,
    owner_epoch integer NOT NULL,
    enrollment_generation bigint DEFAULT 0 NOT NULL,
    fence_generation bigint DEFAULT 0 NOT NULL,
    closed_token uuid,
    closed_transaction_id uuid,
    closed_position bigint,
    publication_job uuid,
    publication_consumer jsonb,
    publication_fence uuid,
    publication_released_fence uuid,
    publication_home integer DEFAULT 0 NOT NULL,
    publication_after uuid,
    publication_revision bigint DEFAULT 0 NOT NULL,
    publication_gate_from bigint,
    publication_gate_through bigint,
    CONSTRAINT identity_writer_gate_check CHECK (((closed_token IS NULL) = (closed_transaction_id IS NULL))),
    CONSTRAINT identity_writer_gate_check1 CHECK (((closed_token IS NULL) = (closed_position IS NULL))),
    CONSTRAINT identity_writer_gate_check2 CHECK (((closed_token IS NULL) = (fence_generation = 0))),
    CONSTRAINT identity_writer_gate_check3 CHECK (((publication_fence IS NULL) OR ((publication_job IS NOT NULL) AND (publication_consumer IS NOT NULL)))),
    CONSTRAINT identity_writer_gate_check4 CHECK (((partition_no = 0) OR (publication_job IS NULL))),
    CONSTRAINT identity_writer_gate_closed_position_check CHECK ((closed_position > 0)),
    CONSTRAINT identity_writer_gate_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT identity_writer_gate_enrollment_generation_check CHECK ((enrollment_generation >= 0)),
    CONSTRAINT identity_writer_gate_fence_generation_check CHECK ((fence_generation >= 0)),
    CONSTRAINT identity_writer_gate_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT identity_writer_gate_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_writer_gate_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_writer_gate_physical_target_check CHECK (((octet_length(physical_target) >= 1) AND (octet_length(physical_target) <= 255))),
    CONSTRAINT identity_writer_gate_publication_consumer_check CHECK ((octet_length((publication_consumer)::text) <= 8192)),
    CONSTRAINT identity_writer_gate_publication_home_check CHECK (((publication_home >= 0) AND (publication_home <= 4096))),
    CONSTRAINT identity_writer_gate_publication_revision_check CHECK ((publication_revision >= 0)),
    CONSTRAINT identity_writer_gate_write_alias_check CHECK (((octet_length(write_alias) >= 1) AND (octet_length(write_alias) <= 255)))
);


--
-- Name: index_home_coverage; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.index_home_coverage (
    partition_no integer NOT NULL,
    consumer text NOT NULL COLLATE pg_catalog."C",
    index_uuid text NOT NULL COLLATE pg_catalog."C",
    revision bigint NOT NULL,
    current jsonb,
    fence jsonb,
    verified jsonb,
    covered_through jsonb,
    attempt jsonb,
    CONSTRAINT index_home_coverage_attempt_check CHECK (((jsonb_typeof(attempt) = 'object'::text) AND (octet_length((attempt)::text) <= 4096))),
    CONSTRAINT index_home_coverage_check CHECK (((fence IS NULL) OR (current IS NOT NULL))),
    CONSTRAINT index_home_coverage_check1 CHECK (((verified IS NULL) = (covered_through IS NULL))),
    CONSTRAINT index_home_coverage_consumer_check CHECK (((octet_length(consumer) >= 1) AND (octet_length(consumer) <= 63))),
    CONSTRAINT index_home_coverage_covered_through_check CHECK (((jsonb_typeof(covered_through) = 'object'::text) AND (octet_length((covered_through)::text) <= 256))),
    CONSTRAINT index_home_coverage_current_check CHECK (((jsonb_typeof(current) = 'object'::text) AND (octet_length((current)::text) <= 2048))),
    CONSTRAINT index_home_coverage_fence_check CHECK (((jsonb_typeof(fence) = 'object'::text) AND (octet_length((fence)::text) <= 512))),
    CONSTRAINT index_home_coverage_index_uuid_check CHECK (((octet_length(index_uuid) >= 1) AND (octet_length(index_uuid) <= 128))),
    CONSTRAINT index_home_coverage_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT index_home_coverage_revision_check CHECK ((revision > 0)),
    CONSTRAINT index_home_coverage_verified_check CHECK (((jsonb_typeof(verified) = 'object'::text) AND (octet_length((verified)::text) <= 2048)))
);


--
-- Name: index_incarnation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.index_incarnation (
    partition_no integer DEFAULT 0 NOT NULL,
    consumer text NOT NULL COLLATE pg_catalog."C",
    index_uuid text NOT NULL COLLATE pg_catalog."C",
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    index_name text NOT NULL COLLATE pg_catalog."C",
    protocol text NOT NULL,
    revision bigint NOT NULL,
    state text NOT NULL,
    origin text NOT NULL,
    population_partition integer NOT NULL,
    population_after uuid,
    population_complete boolean NOT NULL,
    CONSTRAINT index_incarnation_check CHECK (((population_complete AND (population_partition = 4096) AND (population_after IS NULL)) OR ((NOT population_complete) AND (population_partition < 4096)))),
    CONSTRAINT index_incarnation_check1 CHECK (((state <> 'live'::text) OR population_complete)),
    CONSTRAINT index_incarnation_consumer_check CHECK (((octet_length(consumer) >= 1) AND (octet_length(consumer) <= 63))),
    CONSTRAINT index_incarnation_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT index_incarnation_index_name_check CHECK (((octet_length(index_name) >= 1) AND (octet_length(index_name) <= 255))),
    CONSTRAINT index_incarnation_index_uuid_check CHECK (((octet_length(index_uuid) >= 1) AND (octet_length(index_uuid) <= 128))),
    CONSTRAINT index_incarnation_origin_check CHECK ((origin = ANY (ARRAY['created-empty'::text, 'replay'::text, 'audit'::text]))),
    CONSTRAINT index_incarnation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT index_incarnation_population_partition_check CHECK (((population_partition >= 0) AND (population_partition <= 4096))),
    CONSTRAINT index_incarnation_protocol_check CHECK ((protocol = 'subject-coverage-v1'::text)),
    CONSTRAINT index_incarnation_revision_check CHECK ((revision > 0)),
    CONSTRAINT index_incarnation_state_check CHECK ((state = ANY (ARRAY['populating'::text, 'live'::text, 'quarantined'::text, 'retiring'::text])))
);


--
-- Name: index_prefix_control; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.index_prefix_control (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    revision bigint NOT NULL,
    issued_generation bigint NOT NULL,
    allocation_bound boolean DEFAULT false NOT NULL,
    CONSTRAINT index_prefix_control_issued_generation_check CHECK (((issued_generation >= 1) AND (issued_generation <= '9007199254740991'::bigint))),
    CONSTRAINT index_prefix_control_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT index_prefix_control_prefix_check CHECK ((prefix ~ '^[a-z0-9][a-z0-9-]{0,47}$'::text)),
    CONSTRAINT index_prefix_control_revision_check CHECK ((revision > 0))
);


--
-- Name: knowledge_discovery_association; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.knowledge_discovery_association (
    subject_id uuid NOT NULL,
    document_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    published_at timestamp with time zone NOT NULL,
    sequence bigint NOT NULL,
    CONSTRAINT knowledge_discovery_association_published_at_check CHECK (isfinite(published_at)),
    CONSTRAINT knowledge_discovery_association_sequence_check CHECK ((sequence > 0))
);


--
-- Name: knowledge_discovery_installation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.knowledge_discovery_installation (
    version integer NOT NULL,
    CONSTRAINT knowledge_discovery_installation_version_check CHECK ((version = 1))
);


--
-- Name: knowledge_discovery_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.knowledge_discovery_preparation (
    id uuid NOT NULL,
    subject_id uuid NOT NULL,
    revision integer NOT NULL,
    state jsonb NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT knowledge_discovery_preparation_revision_check CHECK ((revision > 0)),
    CONSTRAINT knowledge_discovery_preparation_state_check CHECK ((octet_length((state)::text) <= 16384))
);


--
-- Name: knowledge_discovery_subject; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.knowledge_discovery_subject (
    subject_id uuid NOT NULL,
    sequence bigint NOT NULL,
    CONSTRAINT knowledge_discovery_subject_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: public_filter_coverage_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_preparation (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    definition uuid NOT NULL,
    consumer text NOT NULL,
    generation bigint NOT NULL,
    after_home integer DEFAULT 0 NOT NULL,
    root text NOT NULL,
    population_protocol integer,
    ack_protocol smallint DEFAULT 0 NOT NULL,
    ack_retired boolean DEFAULT false NOT NULL,
    subscription_protocol smallint DEFAULT 0 CONSTRAINT public_filter_coverage_preparati_subscription_protocol_not_null NOT NULL,
    CONSTRAINT public_filter_coverage_preparation_ack_protocol_check CHECK ((ack_protocol = ANY (ARRAY[0, 1]))),
    CONSTRAINT public_filter_coverage_preparation_after_home_check CHECK (((after_home >= 0) AND (after_home <= 4096))),
    CONSTRAINT public_filter_coverage_preparation_check CHECK (((NOT ack_retired) OR (ack_protocol = 1))),
    CONSTRAINT public_filter_coverage_preparation_check1 CHECK (((subscription_protocol = 0) OR ((subscription_protocol = 1) AND (ack_protocol = 1) AND (population_protocol = 1)))),
    CONSTRAINT public_filter_coverage_preparation_generation_check CHECK ((generation >= 0)),
    CONSTRAINT public_filter_coverage_preparation_population_protocol_check CHECK (((population_protocol IS NULL) OR (population_protocol = 1))),
    CONSTRAINT public_filter_coverage_preparation_root_check CHECK ((root ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: public_filter_execution; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_execution (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    id text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL,
    consumer_repair text,
    consumer_window text,
    repair_settlement text,
    page_id uuid,
    page_ordinal integer,
    page_parent text,
    page_consumed integer,
    page_size integer,
    page_raw integer,
    page_status text,
    page_engine_started boolean,
    CONSTRAINT public_filter_execution_consumer_repair_check CHECK ((octet_length(consumer_repair) <= 1048576)),
    CONSTRAINT public_filter_execution_consumer_window_check CHECK ((octet_length(consumer_window) <= 1048576)),
    CONSTRAINT public_filter_execution_execution_check CHECK ((octet_length(execution) <= 1048576)),
    CONSTRAINT public_filter_execution_page_consumed_check CHECK (((page_consumed >= 0) AND (page_consumed <= 200))),
    CONSTRAINT public_filter_execution_page_ordinal_check CHECK (((page_ordinal >= 1) AND (page_ordinal <= 3))),
    CONSTRAINT public_filter_execution_page_raw_check CHECK (((page_raw >= 0) AND (page_raw <= 200))),
    CONSTRAINT public_filter_execution_page_shape CHECK ((((page_id IS NULL) AND (page_ordinal IS NULL) AND (page_parent IS NULL) AND (page_consumed IS NULL) AND (page_size IS NULL) AND (page_raw IS NULL) AND (page_status IS NULL) AND (page_engine_started IS NULL)) OR ((page_id IS NOT NULL) AND (page_ordinal IS NOT NULL) AND (page_consumed IS NOT NULL) AND (page_size IS NOT NULL) AND (page_status IS NOT NULL) AND (((page_status = 'dispatched'::text) AND (page_raw IS NULL)) OR ((page_status = 'complete'::text) AND (page_raw IS NOT NULL) AND (page_raw <= page_size)))))),
    CONSTRAINT public_filter_execution_page_size_check CHECK (((page_size >= 1) AND (page_size <= 200))),
    CONSTRAINT public_filter_execution_page_status_check CHECK ((page_status = ANY (ARRAY['dispatched'::text, 'complete'::text]))),
    CONSTRAINT public_filter_execution_repair_settlement_check CHECK ((octet_length(repair_settlement) <= 16384))
);


--
-- Name: public_filter_observation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_observation (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    registration text NOT NULL COLLATE pg_catalog."C",
    queried text NOT NULL,
    covered text NOT NULL,
    expires_at bigint NOT NULL,
    state text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    prepared_rows text,
    consumer_work text,
    consumer_bootstrap text,
    prepared_build text COLLATE pg_catalog."C",
    prepared_generation numeric,
    CONSTRAINT public_filter_observation_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576)),
    CONSTRAINT public_filter_observation_covered_check CHECK ((octet_length(covered) <= 4096)),
    CONSTRAINT public_filter_observation_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT public_filter_observation_prepared_build_check CHECK ((((prepared_build IS NULL) AND (prepared_generation IS NULL)) OR ((prepared_build IS NOT NULL) AND (prepared_generation > (0)::numeric) AND (scale(prepared_generation) = 0)))),
    CONSTRAINT public_filter_observation_prepared_rows_check CHECK ((octet_length(prepared_rows) <= 1048576)),
    CONSTRAINT public_filter_observation_queried_check CHECK ((octet_length(queried) <= 65536)),
    CONSTRAINT public_filter_observation_revision_check CHECK ((revision > 0)),
    CONSTRAINT public_filter_observation_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closing'::text, 'closed'::text])))
);


--
-- Name: public_filter_registration; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_registration (
    partition_no integer NOT NULL,
    id text NOT NULL COLLATE pg_catalog."C",
    physical_target text NOT NULL COLLATE pg_catalog."C",
    consumer text NOT NULL,
    definition text NOT NULL,
    state text NOT NULL,
    consumer_work text,
    consumer_bootstrap text,
    coverage_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT public_filter_registration_consumer_check CHECK ((octet_length(consumer) <= 8192)),
    CONSTRAINT public_filter_registration_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576)),
    CONSTRAINT public_filter_registration_coverage_generation_check CHECK ((coverage_generation >= 0)),
    CONSTRAINT public_filter_registration_definition_check CHECK ((octet_length(definition) <= 1048576)),
    CONSTRAINT public_filter_registration_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT public_filter_registration_state_check CHECK ((state = ANY (ARRAY['active'::text, 'retired'::text])))
);


--
-- Name: public_filter_target; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_target (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL,
    base_copy_revision bigint DEFAULT 1 CONSTRAINT public_filter_target_copy_revision_not_null NOT NULL,
    CONSTRAINT public_filter_target_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: public_filter_ack_authority; Type: VIEW; Schema: search; Owner: -
--

CREATE VIEW search.public_filter_ack_authority AS
 SELECT j.partition_no,
    j.job,
    j.phase,
    j.fence,
    j.fenced_pass,
    j.pass,
    j.physical_target,
    j.native_incarnation AS incarnation,
    o.registration,
    b.bootstrap,
    o.observation,
    x.id AS execution,
    b.read_definition,
    d.release_digest,
    p.epoch AS owner_epoch,
    c.generation,
    c.root AS enrollment_root,
    r.coverage_generation,
    x.repair_settlement,
    sha256(convert_to((jsonb_build_array(j.binding, j.consumer, b.consumer, b.source_position, b.owner_epoch, r.consumer, r.definition, o.queried, o.covered, o.prepared_build, o.prepared_generation, x.execution, d.source_id, d.configuration, d.capture_digest, d.release_digest, d.dependency_keys, d.coverage_keys))::text, 'UTF8'::name)) AS identity_digest
   FROM (((((((((search.generation_publication j
     JOIN semantic.public_filter_bootstrap b ON ((((b.partition_no = j.partition_no) AND (b.publication_job = j.job)) AND (b.publication_execution = (j.job)::text) AND (b.publication_observation = b.queried) AND (b.snapshot_kind = 'prepared'::text) AND (b.state = 'adopted'::text) AND b.coverage_sealed AND (b.coverage_after = 4096) AND (b.account_after = 4096))))
     JOIN search.public_filter_observation o ON ((((o.partition_no = b.partition_no) AND (o.observation = b.queried)) AND (o.consumer_bootstrap = ('0:'::text || (b.bootstrap)::text)) AND (o.prepared_build = o.consumer_bootstrap) AND (o.state = 'open'::text))))
     JOIN search.public_filter_execution x ON (((x.partition_no = o.partition_no) AND (x.observation = o.observation) AND (x.id = b.publication_execution))))
     JOIN search.public_filter_registration r ON ((((r.partition_no = o.partition_no) AND (r.id = o.registration)) AND (r.state = 'active'::text) AND (r.physical_target = j.physical_target))))
     JOIN search.public_filter_target t ON (((t.partition_no = r.partition_no) AND (t.physical_target = r.physical_target) AND (t.incarnation = j.native_incarnation))))
     JOIN semantic.public_filter_read_definition d ON ((((d.partition_no = b.partition_no) AND (d.read_definition = b.read_definition)) AND ((d.read_definition)::text = (j.binding ->> 'readDefinition'::text)) AND (d.release_digest = (j.consumer ->> 'meaningDigest'::text)))))
     JOIN semantic.public_filter_source s ON (((s.partition_no = d.partition_no) AND (s.source_id = d.source_id) AND (s.configuration = d.configuration))))
     JOIN core.partition p ON (((p.partition_no = s.partition_no) AND (p.epoch = b.owner_epoch) AND (p.epoch = s.owner_epoch) AND (p.write_state = 'active'::text))))
     JOIN search.public_filter_coverage_preparation c ON ((((c.partition_no = r.partition_no) AND (c.registration = r.id) AND (c.bootstrap = b.bootstrap)) AND (c.ack_protocol = 1) AND (c.population_protocol = 1) AND (c.after_home = 4096) AND (c.definition = d.read_definition) AND (c.generation = b.coverage_generation) AND (c.root = b.coverage_root) AND (c.consumer = r.consumer))))
  WHERE ((j.partition_no = 0) AND (j.source_home = 0) AND (j.family = 'subjects'::text) AND ('["scope","catalogue-text"]'::text = ANY (d.coverage_keys)) AND ((j.observation IS NULL) OR (j.observation = o.observation)) AND ((j.bootstrap IS NULL) OR ((j.bootstrap = o.consumer_bootstrap) AND (j.queried = o.queried) AND (j.execution = x.id))) AND ((c.subscription_protocol = 0) OR ((j.subscription_protocol = 1) AND (b.subscription_protocol = 1) AND (EXISTS ( SELECT
           FROM (((core.subject_subscription_v1 m
             JOIN core.subject_retention_domain shared ON ((shared.singleton AND (NOT shared.fenced) AND ((m.registration_generation = shared.registration_generation) AND (m.restore_generation = shared.restore_generation)))))
             JOIN core.publication_authority_epoch owner ON (((owner.home_no = 0) AND (owner.generation = m.registration_generation))))
             JOIN dbos.workflow_writer_fence_domain restore ON ((restore.singleton AND (restore.restore_generation = m.restore_generation))))
          WHERE (((m.job = j.job) AND (m.bootstrap = b.bootstrap) AND (m.definition = d.read_definition) AND (m.physical_target = j.physical_target) AND (m.incarnation = j.native_incarnation) AND (m.consumer = j.consumer) AND (m.generation = j.generation)) AND (shared.store_identity = core.subject_retention_store_v1())))))));


--
-- Name: public_filter_ack_home_clock; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_ack_home_clock (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    first_home integer NOT NULL,
    width integer NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    continuity bigint DEFAULT 0 NOT NULL,
    incarnation uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT public_filter_ack_home_clock_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: public_filter_ack_manifest; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_ack_manifest (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    job uuid NOT NULL,
    version smallint DEFAULT 1 NOT NULL,
    root_revision uuid NOT NULL,
    root_digest bytea NOT NULL,
    generation bigint NOT NULL,
    enrollment_root text NOT NULL,
    owner_epoch integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    terminal uuid NOT NULL,
    binding text NOT NULL,
    ordinal bigint NOT NULL,
    terminal_root text NOT NULL,
    settlement text NOT NULL,
    settlement_digest bytea NOT NULL,
    evidence_revision bigint NOT NULL,
    identity_digest bytea NOT NULL,
    continuity bytea NOT NULL,
    committed_by xid8 NOT NULL,
    CONSTRAINT public_filter_ack_manifest_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT public_filter_ack_manifest_root_digest_check CHECK ((octet_length(root_digest) = 32)),
    CONSTRAINT public_filter_ack_manifest_version_check CHECK ((version = 1))
);


--
-- Name: public_filter_ack_range; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_ack_range (
    partition_no integer NOT NULL,
    job uuid NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    binding text NOT NULL,
    first_home integer NOT NULL,
    width integer NOT NULL,
    identity_digest bytea NOT NULL,
    witness bytea NOT NULL,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    digest bytea NOT NULL,
    predecessor text NOT NULL,
    enrollment_root text NOT NULL,
    left_child uuid,
    right_child uuid,
    CONSTRAINT public_filter_ack_range_binding_check CHECK ((binding ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_ack_range_check CHECK (((first_home % width) = 0)),
    CONSTRAINT public_filter_ack_range_children CHECK ((((left_child IS NULL) = (right_child IS NULL)) AND ((width <= 512) OR (left_child IS NOT NULL)))),
    CONSTRAINT public_filter_ack_range_digest_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT public_filter_ack_range_first_home_check CHECK (((first_home >= 0) AND (first_home <= 4095))),
    CONSTRAINT public_filter_ack_range_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT public_filter_ack_range_width_check CHECK ((width = ANY (ARRAY[1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]))),
    CONSTRAINT public_filter_ack_range_witness_check CHECK ((octet_length(witness) = 32))
);


--
-- Name: public_filter_coverage_page; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_page (
    partition_no integer NOT NULL,
    id uuid NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    registration text NOT NULL COLLATE pg_catalog."C",
    definition text NOT NULL,
    consumer text NOT NULL,
    deadline bigint NOT NULL,
    boundary text,
    boundary_consumed integer NOT NULL,
    boundary_window text,
    ceiling integer NOT NULL,
    state text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    rounds integer DEFAULT 0 NOT NULL,
    charged integer DEFAULT 0 NOT NULL,
    tail text,
    tail_consumed integer,
    pending text,
    work text NOT NULL,
    reference_token uuid,
    CONSTRAINT public_filter_coverage_page_boundary_consumed_check CHECK (((boundary_consumed >= 0) AND (boundary_consumed <= 200))),
    CONSTRAINT public_filter_coverage_page_boundary_window_check CHECK ((octet_length(boundary_window) <= 1048576)),
    CONSTRAINT public_filter_coverage_page_ceiling_check CHECK (((ceiling >= 1) AND (ceiling <= 600))),
    CONSTRAINT public_filter_coverage_page_check CHECK (((charged >= 0) AND (charged <= ceiling))),
    CONSTRAINT public_filter_coverage_page_check1 CHECK ((((boundary IS NULL) AND (boundary_window IS NULL) AND (boundary_consumed = 0)) OR ((boundary IS NOT NULL) AND (boundary_window IS NOT NULL)))),
    CONSTRAINT public_filter_coverage_page_consumer_check CHECK ((octet_length(consumer) <= 65536)),
    CONSTRAINT public_filter_coverage_page_definition_check CHECK ((octet_length(definition) <= 1048576)),
    CONSTRAINT public_filter_coverage_page_revision_check CHECK ((revision > 0)),
    CONSTRAINT public_filter_coverage_page_rounds_check CHECK (((rounds >= 0) AND (rounds <= 3))),
    CONSTRAINT public_filter_coverage_page_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'open'::text, 'sealed'::text, 'finished'::text, 'failed'::text]))),
    CONSTRAINT public_filter_coverage_page_tail_consumed_check CHECK (((tail_consumed >= 0) AND (tail_consumed <= 200))),
    CONSTRAINT public_filter_coverage_page_work_check CHECK ((octet_length(work) <= 65536))
);


--
-- Name: public_filter_pit; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_pit (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    id text NOT NULL COLLATE pg_catalog."C",
    locator text NOT NULL,
    state text NOT NULL,
    CONSTRAINT public_filter_pit_locator_check CHECK ((octet_length(locator) <= 65536)),
    CONSTRAINT public_filter_pit_state_check CHECK ((state = ANY (ARRAY['owned'::text, 'released'::text])))
);


--
-- Name: public_filter_pit_claim; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_pit_claim (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    deadline bigint NOT NULL,
    target_prefix text NOT NULL COLLATE pg_catalog."C",
    retry_after bigint NOT NULL,
    state text DEFAULT 'new'::text NOT NULL,
    consumer_work text,
    CONSTRAINT public_filter_pit_claim_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576)),
    CONSTRAINT public_filter_pit_claim_state_check CHECK ((state = ANY (ARRAY['new'::text, 'opening'::text, 'retained'::text, 'handed'::text, 'closing'::text, 'uncertain'::text])))
);


--
-- Name: public_filter_preparation_segment; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_preparation_segment (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    build text NOT NULL COLLATE pg_catalog."C",
    generation numeric NOT NULL,
    raw_ordinal integer NOT NULL,
    output_ordinal integer,
    payload jsonb NOT NULL,
    CONSTRAINT public_filter_preparation_segment_generation_check CHECK (((generation > (0)::numeric) AND (scale(generation) = 0))),
    CONSTRAINT public_filter_preparation_segment_output_ordinal_check CHECK ((output_ordinal >= 0)),
    CONSTRAINT public_filter_preparation_segment_raw_ordinal_check CHECK ((raw_ordinal >= 0))
);


--
-- Name: public_filter_prepared; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_prepared (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    build text NOT NULL COLLATE pg_catalog."C",
    generation numeric NOT NULL,
    rows text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    segment_state text DEFAULT 'legacy'::text NOT NULL,
    raw_count integer DEFAULT 0 NOT NULL,
    output_count integer DEFAULT 0 NOT NULL,
    raw_exhausted boolean DEFAULT false NOT NULL,
    source_cursor text,
    population_job uuid,
    population_verified boolean DEFAULT false NOT NULL,
    verified_raw integer DEFAULT 0 NOT NULL,
    verified_output integer DEFAULT 0 NOT NULL,
    CONSTRAINT public_filter_prepared_check CHECK (((output_count >= 0) AND (output_count <= raw_count))),
    CONSTRAINT public_filter_prepared_check1 CHECK (((verified_output >= 0) AND (verified_output <= verified_raw))),
    CONSTRAINT public_filter_prepared_generation_check CHECK (((generation > (0)::numeric) AND (scale(generation) = 0))),
    CONSTRAINT public_filter_prepared_raw_count_check CHECK (((raw_count >= 0) AND ((population_job IS NOT NULL) OR (raw_count <= 1000)))),
    CONSTRAINT public_filter_prepared_rows_check CHECK ((octet_length(rows) <= 1048576)),
    CONSTRAINT public_filter_prepared_segment_state_check CHECK ((segment_state = ANY (ARRAY['legacy'::text, 'building'::text, 'complete'::text, 'erasing'::text]))),
    CONSTRAINT public_filter_prepared_source_cursor_check CHECK ((octet_length(source_cursor) <= 4096)),
    CONSTRAINT public_filter_prepared_state_check CHECK ((state = ANY (ARRAY['active'::text, 'erasing'::text]))),
    CONSTRAINT public_filter_prepared_verified_raw_check CHECK ((verified_raw >= 0))
);


--
-- Name: public_filter_reference; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_reference (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    token uuid NOT NULL,
    expires_at bigint NOT NULL
);


--
-- Name: public_filter_repair_authority; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_authority (
    physical_target text NOT NULL COLLATE pg_catalog."C",
    lane integer NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    subject_pages bytea,
    CONSTRAINT public_filter_repair_authority_lane_check CHECK (((lane >= 0) AND (lane <= 3))),
    CONSTRAINT public_filter_repair_authority_revision_check CHECK ((revision >= 0)),
    CONSTRAINT subject_ack_page_clock CHECK (((subject_pages IS NULL) OR ((physical_target = '@source'::text) AND (octet_length(subject_pages) = 512))))
);


--
-- Name: public_filter_repair_effect; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_effect (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    page integer NOT NULL,
    item integer NOT NULL,
    receipt text NOT NULL,
    CONSTRAINT public_filter_repair_effect_item_check CHECK ((item >= 0)),
    CONSTRAINT public_filter_repair_effect_receipt_check CHECK ((octet_length(receipt) <= 1048576))
);


--
-- Name: public_filter_repair_page; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_page (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    ordinal integer NOT NULL,
    has_repairs boolean NOT NULL,
    intent text NOT NULL,
    CONSTRAINT public_filter_repair_page_intent_check CHECK ((octet_length(intent) <= 1048576)),
    CONSTRAINT public_filter_repair_page_ordinal_check CHECK ((ordinal >= 0))
);


--
-- Name: public_filter_repair_subject; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_subject (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    subject uuid NOT NULL,
    home integer NOT NULL,
    revision bigint NOT NULL,
    pending_source text,
    page integer,
    item integer,
    "position" bigint,
    completion bigint
);


--
-- Name: public_filter_repair_verification; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_verification (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    revision bigint DEFAULT 0 NOT NULL,
    progress text,
    evidence_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT public_filter_repair_verification_progress_check CHECK ((octet_length(progress) <= 16384))
);


--
-- Name: public_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_preparation (
    partition_no integer NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    id uuid NOT NULL,
    kind text NOT NULL,
    locator jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    due_at bigint NOT NULL,
    lease_until bigint DEFAULT 0 NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT public_preparation_kind_check CHECK (((kind = ANY (ARRAY['population'::text, 'repair'::text])) OR ((kind = 'close'::text) AND starts_with(prefix, 'close:'::text)))),
    CONSTRAINT public_preparation_locator_check CHECK ((octet_length((locator)::text) <= 131072)),
    CONSTRAINT public_preparation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT public_preparation_revision_check CHECK ((revision > 0))
);


--
-- Name: recent_search; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.recent_search (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    id uuid NOT NULL,
    entry jsonb NOT NULL,
    entry_key text NOT NULL,
    last_used timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT recent_search_check CHECK ((partition_no = (route >> 4))),
    CONSTRAINT recent_search_entry_check CHECK ((octet_length((entry)::text) <= 4096)),
    CONSTRAINT recent_search_revision_check CHECK ((revision > 0))
);


--
-- Name: recent_search_state; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.recent_search_state (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT recent_search_state_check CHECK ((partition_no = (route >> 4))),
    CONSTRAINT recent_search_state_revision_check CHECK ((revision >= 0))
);


--
-- Name: release_relevance_execution; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.release_relevance_execution (
    id uuid NOT NULL,
    principal text NOT NULL,
    request_hash text NOT NULL,
    generation integer NOT NULL,
    source_cut_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT release_relevance_execution_generation_check CHECK ((generation > 0)),
    CONSTRAINT release_relevance_execution_principal_check CHECK ((octet_length(principal) <= 256)),
    CONSTRAINT release_relevance_execution_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT release_relevance_execution_source_cut_hash_check CHECK ((source_cut_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: release_relevance_membership_node; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.release_relevance_membership_node (
    execution_id uuid NOT NULL,
    id uuid NOT NULL,
    depth smallint NOT NULL,
    children uuid[] NOT NULL,
    work_id text COLLATE pg_catalog."C",
    CONSTRAINT release_relevance_membership_node_check CHECK ((((depth < 32) AND (work_id IS NULL)) OR ((depth = 32) AND (work_id IS NOT NULL)))),
    CONSTRAINT release_relevance_membership_node_children_check CHECK ((cardinality(children) = 16)),
    CONSTRAINT release_relevance_membership_node_depth_check CHECK (((depth >= 0) AND (depth <= 32))),
    CONSTRAINT release_relevance_membership_node_work_id_check CHECK (((work_id IS NULL) OR (work_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);


--
-- Name: release_relevance_position; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.release_relevance_position (
    execution_id uuid NOT NULL,
    id uuid NOT NULL,
    parent_id uuid,
    branch_hash text NOT NULL,
    work_digest text NOT NULL,
    membership_root uuid NOT NULL,
    CONSTRAINT release_relevance_position_branch_hash_check CHECK ((branch_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT release_relevance_position_work_digest_check CHECK ((work_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: retained_copy_lane; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.retained_copy_lane (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    lane integer NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT retained_copy_lane_lane_check CHECK (((lane >= 0) AND (lane <= 31))),
    CONSTRAINT retained_copy_lane_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT retained_copy_lane_revision_check CHECK ((revision > 0))
);


--
-- Name: retained_copy_directory; Type: VIEW; Schema: search; Owner: -
--

CREATE VIEW search.retained_copy_directory AS
 SELECT t.partition_no,
    t.physical_target,
    t.incarnation,
    (((t.base_copy_revision)::numeric + COALESCE(l.increment, (0)::numeric)))::bigint AS copy_revision
   FROM (search.public_filter_target t
     CROSS JOIN LATERAL ( SELECT sum(retained_copy_lane.revision) AS increment
           FROM search.retained_copy_lane
          WHERE ((retained_copy_lane.partition_no = t.partition_no) AND (retained_copy_lane.physical_target = t.physical_target))) l);


--
-- Name: review_discovery_receiving; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.review_discovery_receiving (
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    index_uuid text NOT NULL,
    incarnation uuid NOT NULL,
    meaning text NOT NULL,
    partition_no integer NOT NULL,
    acknowledged bigint DEFAULT 0 NOT NULL,
    requested bigint DEFAULT 0 NOT NULL,
    through bigint,
    completed_cut bigint DEFAULT 0 NOT NULL,
    native_position bigint,
    status text DEFAULT 'preparing'::text NOT NULL,
    pending boolean DEFAULT false NOT NULL,
    claim uuid,
    claim_until timestamp with time zone,
    stage jsonb,
    CONSTRAINT review_discovery_receiving_acknowledged_check CHECK ((acknowledged >= 0)),
    CONSTRAINT review_discovery_receiving_check CHECK ((through >= acknowledged)),
    CONSTRAINT review_discovery_receiving_check1 CHECK (((claim IS NULL) = (claim_until IS NULL))),
    CONSTRAINT review_discovery_receiving_completed_cut_check CHECK ((completed_cut >= 0)),
    CONSTRAINT review_discovery_receiving_native_position_check CHECK ((native_position >= 0)),
    CONSTRAINT review_discovery_receiving_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT review_discovery_receiving_requested_check CHECK ((requested >= 0)),
    CONSTRAINT review_discovery_receiving_stage_check CHECK ((octet_length((stage)::text) <= 2097152)),
    CONSTRAINT review_discovery_receiving_status_check CHECK ((status = ANY (ARRAY['preparing'::text, 'ready'::text, 'unavailable'::text])))
);


--
-- Name: review_discovery_receiving_scan; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.review_discovery_receiving_scan (
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    index_uuid text NOT NULL,
    incarnation uuid NOT NULL,
    meaning text NOT NULL,
    partition_no integer DEFAULT 0 NOT NULL,
    CONSTRAINT review_discovery_receiving_scan_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: scope_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    definition jsonb NOT NULL,
    frontier jsonb NOT NULL,
    observation jsonb,
    ordinal_membership_progress jsonb,
    leaf_progress jsonb,
    ordinal_frontier jsonb,
    ordinal_complete boolean DEFAULT false NOT NULL,
    state text DEFAULT 'capture'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    lease_until bigint DEFAULT 0 NOT NULL,
    due_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    ordered_state jsonb,
    CONSTRAINT scope_preparation_definition_check CHECK ((octet_length((definition)::text) <= 262144)),
    CONSTRAINT scope_preparation_frontier_check CHECK ((octet_length((frontier)::text) <= 8192)),
    CONSTRAINT scope_preparation_leaf_progress_check CHECK ((octet_length((leaf_progress)::text) <= 4096)),
    CONSTRAINT scope_preparation_observation_check CHECK ((octet_length((observation)::text) <= 8192)),
    CONSTRAINT scope_preparation_ordered_state_check CHECK ((octet_length((ordered_state)::text) <= 32768)),
    CONSTRAINT scope_preparation_ordinal_frontier_check CHECK ((octet_length((ordinal_frontier)::text) <= 1024)),
    CONSTRAINT scope_preparation_ordinal_membership_progress_check CHECK ((octet_length((ordinal_membership_progress)::text) <= 8192)),
    CONSTRAINT scope_preparation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT scope_preparation_revision_check CHECK ((revision > 0)),
    CONSTRAINT scope_preparation_scope_id_check CHECK ((scope_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scope_preparation_state_check CHECK ((state = ANY (ARRAY['capture'::text, 'ready'::text, 'retained'::text])))
);


--
-- Name: scope_preparation_concept_frontier; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation_concept_frontier (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    parent text NOT NULL COLLATE pg_catalog."C",
    after_key text COLLATE pg_catalog."C",
    CONSTRAINT scope_preparation_concept_frontier_after_key_check CHECK (((octet_length(after_key) >= 1) AND (octet_length(after_key) <= 1024))),
    CONSTRAINT scope_preparation_concept_frontier_parent_check CHECK (((octet_length(parent) >= 1) AND (octet_length(parent) <= 1024))),
    CONSTRAINT scope_preparation_concept_frontier_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: scope_preparation_concept_member; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation_concept_member (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    concept text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT scope_preparation_concept_member_concept_check CHECK (((octet_length(concept) >= 1) AND (octet_length(concept) <= 1024))),
    CONSTRAINT scope_preparation_concept_member_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: scope_preparation_ordered; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation_ordered (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    subject uuid NOT NULL,
    count_key integer NOT NULL,
    name_key bytea NOT NULL,
    hit bytea NOT NULL,
    CONSTRAINT scope_preparation_ordered_count_key_check CHECK (((count_key >= '-2147483647'::integer) AND (count_key <= 0))),
    CONSTRAINT scope_preparation_ordered_hit_check CHECK ((octet_length(hit) <= 16384)),
    CONSTRAINT scope_preparation_ordered_name_key_check CHECK (((octet_length(name_key) >= 1) AND (octet_length(name_key) <= 1537))),
    CONSTRAINT scope_preparation_ordered_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: scope_preparation_ordinal; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation_ordinal (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    cut text NOT NULL COLLATE pg_catalog."C",
    subject uuid NOT NULL,
    ordinal_key text NOT NULL COLLATE pg_catalog."C",
    member_id uuid NOT NULL,
    CONSTRAINT scope_preparation_ordinal_cut_check CHECK ((cut ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scope_preparation_ordinal_ordinal_key_check CHECK ((octet_length(ordinal_key) <= 256)),
    CONSTRAINT scope_preparation_ordinal_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: subject_privacy_intake_v1; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.subject_privacy_intake_v1 (
    birth bigint NOT NULL,
    partition_no integer NOT NULL,
    input_key text NOT NULL COLLATE pg_catalog."C",
    enqueue_revision bigint NOT NULL,
    privacy_base bigint NOT NULL,
    received_by xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT subject_privacy_intake_v1_privacy_base_check CHECK ((privacy_base >= 0))
);


--
-- Name: subject_receiver_dirty_v1; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.subject_receiver_dirty_v1 (
    birth bigint NOT NULL,
    home integer NOT NULL,
    epoch integer NOT NULL,
    through_position bigint NOT NULL,
    change_generation bigint NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT subject_receiver_dirty_v1_change_generation_check CHECK ((change_generation > 0)),
    CONSTRAINT subject_receiver_dirty_v1_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT subject_receiver_dirty_v1_home_check CHECK (((home >= 0) AND (home <= 4095))),
    CONSTRAINT subject_receiver_dirty_v1_through_position_check CHECK ((through_position > 0))
);


--
-- Name: subject_receiver_page_v1; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.subject_receiver_page_v1 (
    birth bigint NOT NULL,
    first_home integer NOT NULL,
    end_home integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    predecessor text NOT NULL,
    root text NOT NULL,
    cuts jsonb NOT NULL,
    adopted_by xid8 NOT NULL,
    CONSTRAINT subject_receiver_page_v1_check CHECK (((end_home <= 4096) AND (((end_home - first_home) >= 1) AND ((end_home - first_home) <= 32)))),
    CONSTRAINT subject_receiver_page_v1_check1 CHECK (((jsonb_typeof(cuts) = 'array'::text) AND (jsonb_array_length(cuts) = (end_home - first_home))))
);


--
-- Name: trending_blocked; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.trending_blocked (
    route integer NOT NULL,
    kind text NOT NULL,
    identity uuid NOT NULL,
    CONSTRAINT trending_blocked_kind_check CHECK ((kind = ANY (ARRAY['account'::text, 'source'::text]))),
    CONSTRAINT trending_blocked_route_check CHECK ((route = 0))
);


--
-- Name: trending_member; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.trending_member (
    route integer NOT NULL,
    term_key text NOT NULL COLLATE pg_catalog."C",
    account_id uuid NOT NULL,
    day date NOT NULL,
    contributed_at timestamp with time zone NOT NULL,
    CONSTRAINT trending_member_route_check CHECK ((route = 0))
);


--
-- Name: trending_term; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.trending_term (
    route integer NOT NULL,
    term_key text NOT NULL COLLATE pg_catalog."C",
    language text NOT NULL,
    source_id uuid NOT NULL,
    display text NOT NULL,
    rank integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT trending_term_display_check CHECK (((octet_length(display) >= 1) AND (octet_length(display) <= 256))),
    CONSTRAINT trending_term_language_check CHECK ((octet_length(language) <= 35)),
    CONSTRAINT trending_term_rank_check CHECK (((rank >= 0) AND (rank <= 16))),
    CONSTRAINT trending_term_route_check CHECK ((route = 0)),
    CONSTRAINT trending_term_term_key_check CHECK ((term_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: discovery_copy discovery_copy_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_copy
    ADD CONSTRAINT discovery_copy_pkey PRIMARY KEY (route, source_id, prefix, generation, kind);


--
-- Name: discovery_erasure discovery_erasure_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_erasure
    ADD CONSTRAINT discovery_erasure_pkey PRIMARY KEY (route, account_id);


--
-- Name: discovery_generation discovery_generation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_generation
    ADD CONSTRAINT discovery_generation_pkey PRIMARY KEY (partition_no, prefix, generation);


--
-- Name: discovery_population discovery_population_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_population
    ADD CONSTRAINT discovery_population_pkey PRIMARY KEY (partition_no, prefix, generation, owner);


--
-- Name: erasure_effect erasure_effect_job_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_effect
    ADD CONSTRAINT erasure_effect_job_key UNIQUE (job);


--
-- Name: erasure_effect erasure_effect_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_effect
    ADD CONSTRAINT erasure_effect_pkey PRIMARY KEY (partition_no, account_id, physical_target, incarnation);


--
-- Name: erasure_progress erasure_progress_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_progress
    ADD CONSTRAINT erasure_progress_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: erasure_target erasure_target_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_target
    ADD CONSTRAINT erasure_target_pkey PRIMARY KEY (partition_no, account_id, copy_home, physical_target, incarnation);


--
-- Name: facet_generation facet_generation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_generation
    ADD CONSTRAINT facet_generation_pkey PRIMARY KEY (partition_no, definition, generation);


--
-- Name: facet_stage facet_stage_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_stage
    ADD CONSTRAINT facet_stage_pkey PRIMARY KEY (partition_no, definition, generation, subject, key);


--
-- Name: facet_value facet_value_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_value
    ADD CONSTRAINT facet_value_pkey PRIMARY KEY (partition_no, definition, generation, value);


--
-- Name: freshness_groups freshness_groups_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.freshness_groups
    ADD CONSTRAINT freshness_groups_pkey PRIMARY KEY (consumer, shard);


--
-- Name: freshness_home freshness_home_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.freshness_home
    ADD CONSTRAINT freshness_home_pkey PRIMARY KEY (partition_no);


--
-- Name: freshness_observation_reset freshness_observation_reset_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.freshness_observation_reset
    ADD CONSTRAINT freshness_observation_reset_pkey PRIMARY KEY (singleton);


--
-- Name: freshness_positions freshness_positions_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.freshness_positions
    ADD CONSTRAINT freshness_positions_pkey PRIMARY KEY (consumer, shard);


--
-- Name: generation_publication_home generation_publication_home_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication_home
    ADD CONSTRAINT generation_publication_home_pkey PRIMARY KEY (partition_no, job);


--
-- Name: generation_publication_lock generation_publication_lock_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication_lock
    ADD CONSTRAINT generation_publication_lock_pkey PRIMARY KEY (physical_target);


--
-- Name: generation_publication generation_publication_partition_no_physical_target_consume_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication
    ADD CONSTRAINT generation_publication_partition_no_physical_target_consume_key UNIQUE (partition_no, physical_target, consumer);


--
-- Name: generation_publication generation_publication_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication
    ADD CONSTRAINT generation_publication_pkey PRIMARY KEY (partition_no, job);


--
-- Name: identity_receiving_native_copy identity_receiving_native_copy_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_copy
    ADD CONSTRAINT identity_receiving_native_copy_pkey PRIMARY KEY (partition_no, plan_id, copy_no);


--
-- Name: identity_receiving_native_document identity_receiving_native_document_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_document
    ADD CONSTRAINT identity_receiving_native_document_pkey PRIMARY KEY (partition_no, physical_target, document_id);


--
-- Name: identity_receiving_native_hold identity_receiving_native_hold_partition_no_hold_id_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_hold
    ADD CONSTRAINT identity_receiving_native_hold_partition_no_hold_id_key UNIQUE (partition_no, hold_id);


--
-- Name: identity_receiving_native_hold identity_receiving_native_hold_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_hold
    ADD CONSTRAINT identity_receiving_native_hold_pkey PRIMARY KEY (partition_no, plan_id);


--
-- Name: identity_receiving_native_operation identity_receiving_native_operation_partition_no_plan_id_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_operation
    ADD CONSTRAINT identity_receiving_native_operation_partition_no_plan_id_key UNIQUE (partition_no, plan_id);


--
-- Name: identity_receiving_native_operation identity_receiving_native_operation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_operation
    ADD CONSTRAINT identity_receiving_native_operation_pkey PRIMARY KEY (partition_no, plan_id, operation_id);


--
-- Name: identity_receiving_native_pending identity_receiving_native_pending_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_pending
    ADD CONSTRAINT identity_receiving_native_pending_pkey PRIMARY KEY (partition_no, physical_target, plan_id);


--
-- Name: identity_receiving_native_plan identity_receiving_native_pla_partition_no_job_id_job_epoch_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_plan
    ADD CONSTRAINT identity_receiving_native_pla_partition_no_job_id_job_epoch_key UNIQUE (partition_no, job_id, job_epoch, effect_key);


--
-- Name: identity_receiving_native_plan identity_receiving_native_plan_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_plan
    ADD CONSTRAINT identity_receiving_native_plan_pkey PRIMARY KEY (partition_no, plan_id);


--
-- Name: identity_receiving_native_scope_pending identity_receiving_native_scope_pending_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_scope_pending
    ADD CONSTRAINT identity_receiving_native_scope_pending_pkey PRIMARY KEY (partition_no, job_id, job_epoch, effect_key);


--
-- Name: identity_writer_gate identity_writer_gate_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_writer_gate
    ADD CONSTRAINT identity_writer_gate_pkey PRIMARY KEY (partition_no, physical_target);


--
-- Name: identity_writer identity_writer_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_writer
    ADD CONSTRAINT identity_writer_pkey PRIMARY KEY (partition_no, physical_target, original_id);


--
-- Name: index_home_coverage index_home_coverage_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_home_coverage
    ADD CONSTRAINT index_home_coverage_pkey PRIMARY KEY (partition_no, consumer, index_uuid);


--
-- Name: index_incarnation index_incarnation_partition_no_prefix_generation_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_partition_no_prefix_generation_key UNIQUE (partition_no, prefix, generation);


--
-- Name: index_incarnation index_incarnation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_pkey PRIMARY KEY (partition_no, consumer, index_uuid);


--
-- Name: index_prefix_control index_prefix_control_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_prefix_control
    ADD CONSTRAINT index_prefix_control_pkey PRIMARY KEY (partition_no, prefix);


--
-- Name: knowledge_discovery_association knowledge_discovery_association_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.knowledge_discovery_association
    ADD CONSTRAINT knowledge_discovery_association_pkey PRIMARY KEY (subject_id, publication_id);


--
-- Name: knowledge_discovery_association knowledge_discovery_association_subject_id_sequence_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.knowledge_discovery_association
    ADD CONSTRAINT knowledge_discovery_association_subject_id_sequence_key UNIQUE (subject_id, sequence);


--
-- Name: knowledge_discovery_installation knowledge_discovery_installation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.knowledge_discovery_installation
    ADD CONSTRAINT knowledge_discovery_installation_pkey PRIMARY KEY (version);


--
-- Name: knowledge_discovery_preparation knowledge_discovery_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.knowledge_discovery_preparation
    ADD CONSTRAINT knowledge_discovery_preparation_pkey PRIMARY KEY (id);


--
-- Name: knowledge_discovery_subject knowledge_discovery_subject_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.knowledge_discovery_subject
    ADD CONSTRAINT knowledge_discovery_subject_pkey PRIMARY KEY (subject_id);


--
-- Name: public_filter_ack_home_clock public_filter_ack_home_clock_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_home_clock
    ADD CONSTRAINT public_filter_ack_home_clock_pkey PRIMARY KEY (bootstrap, first_home, width);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_partition_no_job_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_partition_no_job_key UNIQUE (partition_no, job);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_pkey PRIMARY KEY (partition_no, registration, bootstrap);


--
-- Name: public_filter_ack_range public_filter_ack_range_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_range
    ADD CONSTRAINT public_filter_ack_range_pkey PRIMARY KEY (partition_no, job, binding, first_home, width, witness);


--
-- Name: public_filter_ack_range public_filter_ack_range_revision_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_range
    ADD CONSTRAINT public_filter_ack_range_revision_key UNIQUE (revision);


--
-- Name: public_filter_coverage_baseline public_filter_coverage_baseline_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_baseline
    ADD CONSTRAINT public_filter_coverage_baseline_pkey PRIMARY KEY (partition_no, registration, bootstrap, source_home);


--
-- Name: public_filter_coverage_home public_filter_coverage_home_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_home
    ADD CONSTRAINT public_filter_coverage_home_pkey PRIMARY KEY (partition_no, registration, source_home);


--
-- Name: public_filter_coverage_page public_filter_coverage_page_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_page
    ADD CONSTRAINT public_filter_coverage_page_pkey PRIMARY KEY (partition_no, id);


--
-- Name: public_filter_coverage_preparation public_filter_coverage_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_preparation
    ADD CONSTRAINT public_filter_coverage_preparation_pkey PRIMARY KEY (partition_no, registration, bootstrap);


--
-- Name: public_filter_execution public_filter_execution_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_execution
    ADD CONSTRAINT public_filter_execution_pkey PRIMARY KEY (partition_no, observation, id);


--
-- Name: public_filter_observation public_filter_observation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_observation
    ADD CONSTRAINT public_filter_observation_pkey PRIMARY KEY (partition_no, observation);


--
-- Name: public_filter_pit_claim public_filter_pit_claim_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit_claim
    ADD CONSTRAINT public_filter_pit_claim_pkey PRIMARY KEY (partition_no, bootstrap);


--
-- Name: public_filter_pit public_filter_pit_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit
    ADD CONSTRAINT public_filter_pit_pkey PRIMARY KEY (partition_no, observation, id);


--
-- Name: public_filter_preparation_segment public_filter_preparation_segment_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_preparation_segment
    ADD CONSTRAINT public_filter_preparation_segment_pkey PRIMARY KEY (partition_no, registration, build, generation, raw_ordinal);


--
-- Name: public_filter_prepared public_filter_prepared_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_prepared
    ADD CONSTRAINT public_filter_prepared_pkey PRIMARY KEY (partition_no, registration, build, generation);


--
-- Name: public_filter_reference public_filter_reference_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_reference
    ADD CONSTRAINT public_filter_reference_pkey PRIMARY KEY (partition_no, observation, token);


--
-- Name: public_filter_registration public_filter_registration_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_registration
    ADD CONSTRAINT public_filter_registration_pkey PRIMARY KEY (partition_no, id);


--
-- Name: public_filter_repair_authority public_filter_repair_authority_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_authority
    ADD CONSTRAINT public_filter_repair_authority_pkey PRIMARY KEY (physical_target, lane);


--
-- Name: public_filter_repair_effect public_filter_repair_effect_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_effect
    ADD CONSTRAINT public_filter_repair_effect_pkey PRIMARY KEY (partition_no, observation, execution, page, item);


--
-- Name: public_filter_repair_page public_filter_repair_page_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_page
    ADD CONSTRAINT public_filter_repair_page_pkey PRIMARY KEY (partition_no, observation, execution, ordinal);


--
-- Name: public_filter_repair_subject public_filter_repair_subject_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_subject
    ADD CONSTRAINT public_filter_repair_subject_pkey PRIMARY KEY (partition_no, observation, execution, subject);


--
-- Name: public_filter_repair_verification public_filter_repair_verification_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_verification
    ADD CONSTRAINT public_filter_repair_verification_pkey PRIMARY KEY (partition_no, observation, execution);


--
-- Name: public_filter_target public_filter_target_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_target
    ADD CONSTRAINT public_filter_target_pkey PRIMARY KEY (partition_no, physical_target);


--
-- Name: public_preparation public_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_preparation
    ADD CONSTRAINT public_preparation_pkey PRIMARY KEY (partition_no, id);


--
-- Name: recent_search recent_search_partition_no_route_account_id_entry_key_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_partition_no_route_account_id_entry_key_key UNIQUE (partition_no, route, account_id, entry_key);


--
-- Name: recent_search recent_search_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_pkey PRIMARY KEY (partition_no, route, account_id, id);


--
-- Name: recent_search_state recent_search_state_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search_state
    ADD CONSTRAINT recent_search_state_pkey PRIMARY KEY (partition_no, route, account_id);


--
-- Name: release_relevance_execution release_relevance_execution_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.release_relevance_execution
    ADD CONSTRAINT release_relevance_execution_pkey PRIMARY KEY (id);


--
-- Name: release_relevance_membership_node release_relevance_membership_node_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.release_relevance_membership_node
    ADD CONSTRAINT release_relevance_membership_node_pkey PRIMARY KEY (execution_id, id);


--
-- Name: release_relevance_position release_relevance_position_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.release_relevance_position
    ADD CONSTRAINT release_relevance_position_pkey PRIMARY KEY (execution_id, id);


--
-- Name: retained_copy_lane retained_copy_lane_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.retained_copy_lane
    ADD CONSTRAINT retained_copy_lane_pkey PRIMARY KEY (partition_no, physical_target, lane);


--
-- Name: review_discovery_receiving review_discovery_receiving_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.review_discovery_receiving
    ADD CONSTRAINT review_discovery_receiving_pkey PRIMARY KEY (prefix, generation, index_uuid, incarnation, meaning, partition_no);


--
-- Name: review_discovery_receiving_scan review_discovery_receiving_scan_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.review_discovery_receiving_scan
    ADD CONSTRAINT review_discovery_receiving_scan_pkey PRIMARY KEY (prefix, generation, index_uuid, incarnation, meaning);


--
-- Name: scope_preparation_concept_frontier scope_preparation_concept_frontier_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation_concept_frontier
    ADD CONSTRAINT scope_preparation_concept_frontier_pkey PRIMARY KEY (partition_no, prefix, scope_id, parent);


--
-- Name: scope_preparation_concept_member scope_preparation_concept_member_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation_concept_member
    ADD CONSTRAINT scope_preparation_concept_member_pkey PRIMARY KEY (partition_no, prefix, scope_id, concept);


--
-- Name: scope_preparation_ordered scope_preparation_ordered_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation_ordered
    ADD CONSTRAINT scope_preparation_ordered_pkey PRIMARY KEY (partition_no, prefix, scope_id, subject);


--
-- Name: scope_preparation_ordinal scope_preparation_ordinal_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation_ordinal
    ADD CONSTRAINT scope_preparation_ordinal_pkey PRIMARY KEY (partition_no, prefix, scope_id, cut, subject);


--
-- Name: scope_preparation scope_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation
    ADD CONSTRAINT scope_preparation_pkey PRIMARY KEY (partition_no, prefix, scope_id);


--
-- Name: subject_privacy_intake_v1 subject_privacy_intake_v1_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_privacy_intake_v1
    ADD CONSTRAINT subject_privacy_intake_v1_pkey PRIMARY KEY (birth, partition_no, input_key, enqueue_revision);


--
-- Name: subject_receiver_dirty_v1 subject_receiver_dirty_v1_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_receiver_dirty_v1
    ADD CONSTRAINT subject_receiver_dirty_v1_pkey PRIMARY KEY (birth, home);


--
-- Name: subject_receiver_page_v1 subject_receiver_page_v1_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_receiver_page_v1
    ADD CONSTRAINT subject_receiver_page_v1_pkey PRIMARY KEY (birth, first_home);


--
-- Name: trending_blocked trending_blocked_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_blocked
    ADD CONSTRAINT trending_blocked_pkey PRIMARY KEY (route, kind, identity);


--
-- Name: trending_member trending_member_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_member
    ADD CONSTRAINT trending_member_pkey PRIMARY KEY (route, term_key, account_id);


--
-- Name: trending_term trending_term_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_term
    ADD CONSTRAINT trending_term_pkey PRIMARY KEY (route, term_key);


--
-- Name: discovery_copy_generation; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX discovery_copy_generation ON search.discovery_copy USING btree (prefix, generation, route, source_id, kind);


--
-- Name: discovery_generation_live; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX discovery_generation_live ON search.discovery_generation USING btree (partition_no, prefix, generation) WHERE (state <> 'retired'::text);


--
-- Name: discovery_population_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX discovery_population_pending ON search.discovery_population USING btree (prefix, generation, partition_no, owner) WHERE (NOT complete);


--
-- Name: discovery_population_uncertified; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX discovery_population_uncertified ON search.discovery_population USING btree (prefix, generation, partition_no, owner) WHERE (NOT certified);


--
-- Name: facet_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX facet_expiry ON search.facet_generation USING btree (expires_at, partition_no, definition, generation);


--
-- Name: facet_one_building; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX facet_one_building ON search.facet_generation USING btree (partition_no, definition) WHERE (state = 'building'::text);


--
-- Name: facet_one_ready; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX facet_one_ready ON search.facet_generation USING btree (partition_no, definition) WHERE (state = 'ready'::text);


--
-- Name: freshness_pending_home; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX freshness_pending_home ON search.freshness_positions USING btree (shard) WHERE ((consumer = ''::text) AND pending);


--
-- Name: freshness_position_change; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX freshness_position_change ON search.freshness_positions USING btree (consumer, change_xid) WHERE (change_xid IS NOT NULL);


--
-- Name: generation_publication_bootstrap; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX generation_publication_bootstrap ON search.generation_publication USING btree (partition_no, bootstrap) WHERE (bootstrap IS NOT NULL);


--
-- Name: generation_publication_home_frontier; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX generation_publication_home_frontier ON search.generation_publication_home USING btree (job, pass, partition_no);


--
-- Name: generation_publication_subject_coverage; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX generation_publication_subject_coverage ON search.generation_publication USING btree (partition_no, physical_target, native_incarnation) WHERE ((family = 'subjects'::text) AND (phase = 'active'::text));


--
-- Name: identity_receiving_native_copy_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX identity_receiving_native_copy_pending ON search.identity_receiving_native_copy USING btree (partition_no, plan_id, copy_no) WHERE (reconciled_transaction_id IS NULL);


--
-- Name: identity_receiving_native_pending_target; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX identity_receiving_native_pending_target ON search.identity_receiving_native_pending USING btree (physical_target, partition_no, plan_id);


--
-- Name: identity_writer_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX identity_writer_pending ON search.identity_writer USING btree (partition_no, physical_target, original_id) WHERE (writer_token IS NOT NULL);


--
-- Name: identity_writer_publication_gate_cut; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX identity_writer_publication_gate_cut ON search.identity_writer_gate USING btree (owner_epoch, publication_gate_through) WHERE ((partition_no = 0) AND (publication_gate_through IS NOT NULL));


--
-- Name: identity_writer_target_frontier; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX identity_writer_target_frontier ON search.identity_writer USING btree (physical_target, partition_no);


--
-- Name: index_home_coverage_retire; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX index_home_coverage_retire ON search.index_home_coverage USING btree (consumer, index_uuid, partition_no);


--
-- Name: knowledge_discovery_preparation_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX knowledge_discovery_preparation_expiry ON search.knowledge_discovery_preparation USING btree (expires_at, id);


--
-- Name: knowledge_discovery_preparation_subject; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX knowledge_discovery_preparation_subject ON search.knowledge_discovery_preparation USING btree (subject_id, expires_at, id);


--
-- Name: knowledge_discovery_publication_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX knowledge_discovery_publication_page ON search.knowledge_discovery_association USING btree (subject_id, published_at DESC, document_id, publication_id);


--
-- Name: public_filter_ack_delta; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_ack_delta ON search.public_filter_coverage_home USING btree (partition_no, registration, source_home) WHERE baseline_delta;


--
-- Name: public_filter_ack_manifest_observation; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_ack_manifest_observation ON search.public_filter_ack_manifest USING btree (partition_no, observation);


--
-- Name: public_filter_ack_protocol_cut; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_ack_protocol_cut ON search.public_filter_coverage_preparation USING btree (bootstrap) WHERE (ack_protocol = 1);


--
-- Name: public_filter_coverage_behind; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_behind ON search.public_filter_coverage_home USING btree (partition_no, registration, source_home) WHERE behind;


--
-- Name: public_filter_coverage_changed; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_changed ON search.public_filter_coverage_home USING btree (partition_no, registration, last_change_generation, source_home);


--
-- Name: public_filter_coverage_page_active; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_page_active ON search.public_filter_coverage_page USING btree (partition_no, observation) WHERE ((state = ANY (ARRAY['planned'::text, 'open'::text, 'sealed'::text])) OR (pending IS NOT NULL));


--
-- Name: public_filter_coverage_page_drain; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_page_drain ON search.public_filter_coverage_page USING btree (partition_no, observation, id) WHERE (state = ANY (ARRAY['planned'::text, 'open'::text, 'sealed'::text]));


--
-- Name: public_filter_coverage_page_observation; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_page_observation ON search.public_filter_coverage_page USING btree (partition_no, observation, id);


--
-- Name: public_filter_execution_page; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_execution_page ON search.public_filter_execution USING btree (partition_no, page_id, page_ordinal) WHERE (page_id IS NOT NULL);


--
-- Name: public_filter_observation_bootstrap; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_observation_bootstrap ON search.public_filter_observation USING btree (partition_no, consumer_bootstrap) WHERE (consumer_bootstrap IS NOT NULL);


--
-- Name: public_filter_observation_covered; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_observation_covered ON search.public_filter_observation USING btree (partition_no, registration, md5(covered), prepared_build) WHERE (state = 'open'::text);


--
-- Name: public_filter_observation_prepared_build; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_observation_prepared_build ON search.public_filter_observation USING btree (partition_no, registration, prepared_build, prepared_generation) WHERE ((prepared_build IS NOT NULL) AND (state = 'open'::text));


--
-- Name: public_filter_observation_publication; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_observation_publication ON search.public_filter_observation USING btree (partition_no, registration, observation DESC) WHERE (state = 'open'::text);


--
-- Name: public_filter_observation_registration; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_observation_registration ON search.public_filter_observation USING btree (partition_no, registration, observation);


--
-- Name: public_filter_pit_claim_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_pit_claim_due ON search.public_filter_pit_claim USING btree (target_prefix, retry_after, partition_no, bootstrap) WHERE (state <> 'uncertain'::text);


--
-- Name: public_filter_pit_claim_physical_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_pit_claim_physical_due ON search.public_filter_pit_claim USING btree (target_prefix, retry_after, partition_no, bootstrap) WHERE (state = ANY (ARRAY['retained'::text, 'handed'::text, 'closing'::text]));


--
-- Name: public_filter_pit_owned; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_pit_owned ON search.public_filter_pit USING btree (partition_no, observation, id) WHERE (state = 'owned'::text);


--
-- Name: public_filter_preparation_segment_output; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_preparation_segment_output ON search.public_filter_preparation_segment USING btree (partition_no, registration, build, generation, output_ordinal) WHERE (output_ordinal IS NOT NULL);


--
-- Name: public_filter_reference_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_reference_expiry ON search.public_filter_reference USING btree (partition_no, observation, expires_at);


--
-- Name: public_filter_registration_bootstrap; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_registration_bootstrap ON search.public_filter_registration USING btree (partition_no, consumer_bootstrap) WHERE (consumer_bootstrap IS NOT NULL);


--
-- Name: public_filter_registration_publication; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_registration_publication ON search.public_filter_registration USING btree (physical_target, md5(consumer), partition_no) WHERE (state = 'active'::text);


--
-- Name: public_filter_registration_target; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_registration_target ON search.public_filter_registration USING btree (partition_no, physical_target, id);


--
-- Name: public_filter_repair_page_effects; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_repair_page_effects ON search.public_filter_repair_page USING btree (partition_no, observation, execution, ordinal) WHERE has_repairs;


--
-- Name: public_filter_repair_subject_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_repair_subject_pending ON search.public_filter_repair_subject USING btree (partition_no, observation, execution, revision) WHERE (pending_source IS NOT NULL);


--
-- Name: public_filter_repair_subject_winners; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_repair_subject_winners ON search.public_filter_repair_subject USING btree (partition_no, observation, execution, revision, home, subject) WHERE (page IS NOT NULL);


--
-- Name: public_filter_target_physical; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_target_physical ON search.public_filter_target USING btree (physical_target, partition_no);


--
-- Name: public_preparation_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_preparation_due ON search.public_preparation USING btree (partition_no, prefix, due_at, id);


--
-- Name: public_preparation_locator; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_preparation_locator ON search.public_preparation USING btree (partition_no, prefix, kind, ((locator ->> 'key'::text)));


--
-- Name: recent_search_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX recent_search_expiry ON search.recent_search USING btree (partition_no, expires_at, route, account_id, id);


--
-- Name: recent_search_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX recent_search_page ON search.recent_search USING btree (partition_no, route, account_id, last_used DESC, id DESC);


--
-- Name: release_relevance_execution_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX release_relevance_execution_expiry ON search.release_relevance_execution USING btree (expires_at, id);


--
-- Name: release_relevance_membership_position_root; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX release_relevance_membership_position_root ON search.release_relevance_position USING btree (execution_id, membership_root);


--
-- Name: release_relevance_position_branch; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX release_relevance_position_branch ON search.release_relevance_position USING btree (execution_id, parent_id, branch_hash) WHERE (parent_id IS NOT NULL);


--
-- Name: review_discovery_receiving_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX review_discovery_receiving_pending ON search.review_discovery_receiving USING btree (prefix, generation, index_uuid, incarnation, meaning, partition_no) WHERE pending;


--
-- Name: scope_preparation_concept_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_concept_expiry ON search.scope_preparation USING btree (partition_no, prefix, expires_at, scope_id) WHERE (((definition ->> 'kind'::text) = 'concept'::text) AND (state = ANY (ARRAY['capture'::text, 'ready'::text])));


--
-- Name: scope_preparation_concept_retired; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_concept_retired ON search.scope_preparation USING btree (partition_no, prefix, scope_id) WHERE (((definition ->> 'kind'::text) = 'concept'::text) AND (state = 'retained'::text) AND ((frontier ->> 'cleaned'::text) IS DISTINCT FROM 'true'::text));


--
-- Name: scope_preparation_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_due ON search.scope_preparation USING btree (prefix, due_at, scope_id) WHERE (state = 'capture'::text);


--
-- Name: scope_preparation_ordered_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_ordered_page ON search.scope_preparation_ordered USING btree (partition_no, prefix, scope_id, count_key, name_key, subject);


--
-- Name: scope_preparation_ordinal_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_ordinal_page ON search.scope_preparation_ordinal USING btree (partition_no, prefix, scope_id, cut, ordinal_key, member_id);


--
-- Name: subject_receiver_changed_v1; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX subject_receiver_changed_v1 ON search.subject_receiver_dirty_v1 USING btree (registration, change_generation, home);


--
-- Name: subject_receiver_live_registration_v1; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX subject_receiver_live_registration_v1 ON search.public_filter_coverage_preparation USING btree (partition_no, registration) WHERE ((subscription_protocol = 1) AND (NOT ack_retired));


--
-- Name: trending_member_account; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_member_account ON search.trending_member USING btree (route, account_id, term_key);


--
-- Name: trending_term_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_expiry ON search.trending_term USING btree (route, expires_at, term_key);


--
-- Name: trending_term_live_rank; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_live_rank ON search.trending_term USING btree (route, language, rank DESC, expires_at DESC, term_key);


--
-- Name: trending_term_rank; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_rank ON search.trending_term USING btree (route, language, rank DESC, term_key);


--
-- Name: trending_term_source; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_source ON search.trending_term USING btree (route, source_id, term_key);


--
-- Name: public_filter_observation erasure_enroll_observation; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER erasure_enroll_observation AFTER INSERT ON search.public_filter_observation FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();


--
-- Name: public_filter_prepared erasure_enroll_prepared; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER erasure_enroll_prepared AFTER INSERT ON search.public_filter_prepared FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();


--
-- Name: public_filter_registration erasure_enroll_registration; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER erasure_enroll_registration AFTER INSERT ON search.public_filter_registration FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();


--
-- Name: freshness_positions freshness_observation_moved; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER freshness_observation_moved AFTER UPDATE OF consumer, shard ON search.freshness_positions FOR EACH ROW WHEN (((old.consumer IS DISTINCT FROM new.consumer) OR (old.shard IS DISTINCT FROM new.shard))) EXECUTE FUNCTION search.reset_freshness_observation();

ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER freshness_observation_moved;


--
-- Name: freshness_positions freshness_observation_removed; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER freshness_observation_removed AFTER DELETE ON search.freshness_positions REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION search.reset_deleted_freshness_points();

ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER freshness_observation_removed;


--
-- Name: freshness_positions freshness_observation_reset; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER freshness_observation_reset AFTER TRUNCATE ON search.freshness_positions FOR EACH STATEMENT EXECUTE FUNCTION search.reset_freshness_observation();

ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER freshness_observation_reset;


--
-- Name: freshness_home freshness_position; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF head, checkpoint_ceiling ON search.freshness_home FOR EACH ROW EXECUTE FUNCTION search.retain_pending_freshness_home();

ALTER TABLE search.freshness_home ENABLE ALWAYS TRIGGER freshness_position;


--
-- Name: public_filter_preparation_segment generation_population_append; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER generation_population_append AFTER INSERT ON search.public_filter_preparation_segment REFERENCING NEW TABLE AS appended FOR EACH STATEMENT EXECUTE FUNCTION search.require_generation_population_batch();


--
-- Name: public_filter_preparation_segment generation_population_update; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER generation_population_update AFTER UPDATE ON search.public_filter_preparation_segment REFERENCING NEW TABLE AS appended FOR EACH STATEMENT EXECUTE FUNCTION search.require_generation_population_batch();


--
-- Name: generation_publication generation_publication_ack_protocol_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER generation_publication_ack_protocol_immutable BEFORE UPDATE OF ack_protocol ON search.generation_publication FOR EACH ROW WHEN ((old.ack_protocol IS DISTINCT FROM new.ack_protocol)) EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_receiving_native_plan identity_receiving_native_plan_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER identity_receiving_native_plan_immutable BEFORE DELETE OR UPDATE ON search.identity_receiving_native_plan FOR EACH ROW EXECUTE FUNCTION search.prevent_receiving_plan_mutation();


--
-- Name: identity_writer identity_writer_clear_settled_relay_intent; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER identity_writer_clear_settled_relay_intent BEFORE UPDATE OF writer_token ON search.identity_writer FOR EACH ROW WHEN (((old.relay_intent IS NOT NULL) AND (new.relay_intent = old.relay_intent) AND (old.relay_receipt IS NOT NULL) AND (new.relay_receipt IS NULL) AND (new.dispatch_state = 'settled'::text) AND (new.writer_token IS NULL))) EXECUTE FUNCTION search.clear_settled_relay_intent();


--
-- Name: public_filter_preparation_segment invalidate_deleted_population_ordinals; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER invalidate_deleted_population_ordinals AFTER DELETE ON search.public_filter_preparation_segment REFERENCING OLD TABLE AS original_segments FOR EACH STATEMENT EXECUTE FUNCTION search.invalidate_population_verification();


--
-- Name: public_filter_preparation_segment invalidate_updated_population_ordinals; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER invalidate_updated_population_ordinals AFTER UPDATE ON search.public_filter_preparation_segment REFERENCING OLD TABLE AS original_segments FOR EACH STATEMENT EXECUTE FUNCTION search.invalidate_population_verification();


--
-- Name: freshness_positions mark_freshness_position_change; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER mark_freshness_position_change BEFORE INSERT OR UPDATE OF consumer, shard, positions ON search.freshness_positions FOR EACH ROW EXECUTE FUNCTION search.mark_freshness_position_change();

ALTER TABLE search.freshness_positions ENABLE ALWAYS TRIGGER mark_freshness_position_change;


--
-- Name: public_filter_coverage_baseline public_filter_ack_baseline_loss; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_baseline_loss AFTER DELETE ON search.public_filter_coverage_baseline FOR EACH ROW EXECUTE FUNCTION search.public_filter_ack_receipt_loss();


--
-- Name: public_filter_coverage_preparation public_filter_ack_clock_pin; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_clock_pin AFTER INSERT ON search.public_filter_coverage_preparation FOR EACH ROW WHEN ((new.ack_protocol = 1)) EXECUTE FUNCTION search.begin_public_filter_ack_clock();


--
-- Name: public_filter_coverage_home public_filter_ack_home_delta; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_home_delta BEFORE INSERT OR DELETE OR UPDATE ON search.public_filter_coverage_home FOR EACH ROW EXECUTE FUNCTION search.classify_public_filter_ack_home();


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_bind; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_manifest_bind BEFORE INSERT ON search.public_filter_ack_manifest FOR EACH ROW EXECUTE FUNCTION search.bind_public_filter_ack_manifest();


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_manifest_immutable BEFORE UPDATE ON search.public_filter_ack_manifest FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_live; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_manifest_live BEFORE INSERT ON search.public_filter_ack_manifest FOR EACH ROW EXECUTE FUNCTION search.require_public_filter_ack_live_cut();


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_retire; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_manifest_retire BEFORE DELETE ON search.public_filter_ack_manifest FOR EACH ROW EXECUTE FUNCTION search.retire_public_filter_ack_manifest();


--
-- Name: public_filter_coverage_preparation public_filter_ack_protocol_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_protocol_immutable BEFORE UPDATE OF ack_protocol ON search.public_filter_coverage_preparation FOR EACH ROW WHEN ((old.ack_protocol IS DISTINCT FROM new.ack_protocol)) EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: public_filter_coverage_preparation public_filter_ack_protocol_retained; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_protocol_retained BEFORE DELETE ON search.public_filter_coverage_preparation FOR EACH ROW WHEN ((old.ack_protocol = 1)) EXECUTE FUNCTION search.retain_public_filter_ack_protocol();


--
-- Name: public_filter_ack_range public_filter_ack_range_compare; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_range_compare BEFORE INSERT ON search.public_filter_ack_range FOR EACH ROW WHEN ((NOT (search.shared_subject_job_v1(new.job) AND (new.width <= 512) AND (new.left_child IS NULL) AND (new.right_child IS NULL)))) EXECUTE FUNCTION search.compare_public_filter_ack_range();


--
-- Name: public_filter_ack_range public_filter_ack_range_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_range_immutable BEFORE UPDATE ON search.public_filter_ack_range FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: public_filter_coverage_preparation public_filter_ack_retirement_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_ack_retirement_immutable BEFORE UPDATE OF ack_retired ON search.public_filter_coverage_preparation FOR EACH ROW WHEN ((old.ack_retired AND (NOT new.ack_retired))) EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: public_filter_coverage_baseline public_filter_coverage_baseline_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_coverage_baseline_immutable BEFORE UPDATE ON search.public_filter_coverage_baseline FOR EACH ROW EXECUTE FUNCTION search.retain_public_filter_coverage_baseline();


--
-- Name: public_filter_coverage_page public_filter_coverage_page_guard; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_coverage_page_guard BEFORE INSERT OR DELETE OR UPDATE ON search.public_filter_coverage_page FOR EACH ROW EXECUTE FUNCTION search.guard_public_filter_coverage_page();


--
-- Name: public_filter_coverage_preparation public_filter_coverage_preparation_contiguous; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_coverage_preparation_contiguous BEFORE UPDATE ON search.public_filter_coverage_preparation FOR EACH ROW EXECUTE FUNCTION search.advance_public_filter_coverage_preparation();


--
-- Name: public_filter_execution public_filter_page_execution_guard; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_page_execution_guard BEFORE INSERT OR DELETE OR UPDATE ON search.public_filter_execution FOR EACH ROW EXECUTE FUNCTION search.guard_public_filter_page_execution();


--
-- Name: public_filter_coverage_preparation public_filter_population_protocol_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_population_protocol_immutable BEFORE UPDATE ON search.public_filter_coverage_preparation FOR EACH ROW EXECUTE FUNCTION search.retain_public_filter_population_protocol();


--
-- Name: discovery_generation public_filter_repair_allocation_revision; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_repair_allocation_revision AFTER DELETE OR UPDATE OF prefix, generation, index_uuid, incarnation, state ON search.discovery_generation FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_allocation();


--
-- Name: discovery_copy public_filter_repair_copy_revision; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_repair_copy_revision AFTER INSERT OR DELETE OR UPDATE ON search.discovery_copy FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_copy();


--
-- Name: public_filter_repair_effect public_filter_repair_effect_revision; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_repair_effect_revision AFTER INSERT OR DELETE OR UPDATE ON search.public_filter_repair_effect FOR EACH ROW EXECUTE FUNCTION search.invalidate_public_filter_repair_evidence();


--
-- Name: identity_writer_gate public_filter_repair_gate_revision; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_repair_gate_revision AFTER INSERT OR DELETE OR UPDATE OF partition_no, physical_target, consumer, incarnation, owner_epoch, write_alias, closed_token, enrollment_generation, fence_generation ON search.identity_writer_gate FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_writer();


--
-- Name: public_filter_repair_page public_filter_repair_page_revision; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_repair_page_revision AFTER INSERT OR DELETE OR UPDATE ON search.public_filter_repair_page FOR EACH ROW EXECUTE FUNCTION search.invalidate_public_filter_repair_evidence();


--
-- Name: identity_writer public_filter_repair_writer_revision; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_repair_writer_revision AFTER INSERT OR DELETE OR UPDATE ON search.identity_writer FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_writer();


--
-- Name: generation_publication subject_job_protocol; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_job_protocol BEFORE UPDATE OF subscription_protocol ON search.generation_publication FOR EACH ROW WHEN ((new.subscription_protocol <> old.subscription_protocol)) EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: subject_privacy_intake_v1 subject_privacy_intake_immutable_v1; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_privacy_intake_immutable_v1 BEFORE DELETE OR UPDATE ON search.subject_privacy_intake_v1 FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();


--
-- Name: subject_privacy_intake_v1 subject_privacy_intake_truncate_v1; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_privacy_intake_truncate_v1 BEFORE TRUNCATE ON search.subject_privacy_intake_v1 FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();


--
-- Name: subject_privacy_intake_v1 subject_privacy_intake_v1; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_privacy_intake_v1 BEFORE INSERT ON search.subject_privacy_intake_v1 FOR EACH ROW EXECUTE FUNCTION semantic.guard_subject_privacy_intake_v1();


--
-- Name: public_filter_ack_range subject_receiver_compact_compare; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_compact_compare BEFORE INSERT ON search.public_filter_ack_range FOR EACH ROW WHEN ((search.shared_subject_job_v1(new.job) AND (new.width = ANY (ARRAY[64, 128, 256, 512])) AND (new.left_child IS NULL) AND (new.right_child IS NULL))) EXECUTE FUNCTION search.compare_subject_compact_range_v1();


--
-- Name: subject_receiver_dirty_v1 subject_receiver_dirty_monotone; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_dirty_monotone BEFORE UPDATE ON search.subject_receiver_dirty_v1 FOR EACH ROW WHEN ((((((old.birth IS DISTINCT FROM new.birth) OR (old.home IS DISTINCT FROM new.home)) OR (old.epoch IS DISTINCT FROM new.epoch)) OR (old.registration IS DISTINCT FROM new.registration)) OR (new.through_position < old.through_position) OR (new.change_generation < old.change_generation))) EXECUTE FUNCTION semantic.prevent_revision_mutation();

ALTER TABLE search.subject_receiver_dirty_v1 ENABLE ALWAYS TRIGGER subject_receiver_dirty_monotone;


--
-- Name: subject_receiver_dirty_v1 subject_receiver_dirty_original; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_dirty_original BEFORE DELETE ON search.subject_receiver_dirty_v1 FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();

ALTER TABLE search.subject_receiver_dirty_v1 ENABLE ALWAYS TRIGGER subject_receiver_dirty_original;


--
-- Name: subject_receiver_dirty_v1 subject_receiver_dirty_truncate; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_dirty_truncate BEFORE TRUNCATE ON search.subject_receiver_dirty_v1 FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();

ALTER TABLE search.subject_receiver_dirty_v1 ENABLE ALWAYS TRIGGER subject_receiver_dirty_truncate;


--
-- Name: public_filter_coverage_preparation subject_receiver_format; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_format BEFORE INSERT ON search.public_filter_coverage_preparation FOR EACH ROW EXECUTE FUNCTION search.require_subject_receiver_format_v1();


--
-- Name: subject_privacy_intake_v1 subject_receiver_intake; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_intake AFTER INSERT ON search.subject_privacy_intake_v1 FOR EACH ROW EXECUTE FUNCTION search.apply_subject_privacy_intake_v1();

ALTER TABLE search.subject_privacy_intake_v1 ENABLE ALWAYS TRIGGER subject_receiver_intake;


--
-- Name: public_filter_ack_range subject_receiver_leaf_compare; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_leaf_compare BEFORE INSERT ON search.public_filter_ack_range FOR EACH ROW WHEN ((search.shared_subject_job_v1(new.job) AND (new.width <= 32) AND (new.left_child IS NULL) AND (new.right_child IS NULL))) EXECUTE FUNCTION search.compare_subject_receiver_leaf_v1();


--
-- Name: subject_receiver_page_v1 subject_receiver_page_bind; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_page_bind BEFORE INSERT ON search.subject_receiver_page_v1 FOR EACH ROW EXECUTE FUNCTION search.bind_subject_receiver_page_v1();

ALTER TABLE search.subject_receiver_page_v1 ENABLE ALWAYS TRIGGER subject_receiver_page_bind;


--
-- Name: subject_receiver_page_v1 subject_receiver_page_original; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_page_original BEFORE DELETE OR UPDATE ON search.subject_receiver_page_v1 FOR EACH ROW EXECUTE FUNCTION core.retain_subject_original_v1();

ALTER TABLE search.subject_receiver_page_v1 ENABLE ALWAYS TRIGGER subject_receiver_page_original;


--
-- Name: subject_receiver_page_v1 subject_receiver_page_truncate; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_page_truncate BEFORE TRUNCATE ON search.subject_receiver_page_v1 FOR EACH STATEMENT EXECUTE FUNCTION core.retain_subject_original_v1();

ALTER TABLE search.subject_receiver_page_v1 ENABLE ALWAYS TRIGGER subject_receiver_page_truncate;


--
-- Name: public_filter_coverage_preparation subject_receiver_protocol; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER subject_receiver_protocol BEFORE UPDATE OF subscription_protocol ON search.public_filter_coverage_preparation FOR EACH ROW WHEN ((new.subscription_protocol <> old.subscription_protocol)) EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: facet_stage facet_stage_partition_no_definition_generation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_stage
    ADD CONSTRAINT facet_stage_partition_no_definition_generation_fkey FOREIGN KEY (partition_no, definition, generation) REFERENCES search.facet_generation(partition_no, definition, generation);


--
-- Name: facet_value facet_value_partition_no_definition_generation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_value
    ADD CONSTRAINT facet_value_partition_no_definition_generation_fkey FOREIGN KEY (partition_no, definition, generation) REFERENCES search.facet_generation(partition_no, definition, generation);


--
-- Name: identity_receiving_native_copy identity_receiving_native_copy_partition_no_plan_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_copy
    ADD CONSTRAINT identity_receiving_native_copy_partition_no_plan_id_fkey FOREIGN KEY (partition_no, plan_id) REFERENCES search.identity_receiving_native_plan(partition_no, plan_id);


--
-- Name: identity_receiving_native_hold identity_receiving_native_hold_partition_no_plan_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_hold
    ADD CONSTRAINT identity_receiving_native_hold_partition_no_plan_id_fkey FOREIGN KEY (partition_no, plan_id) REFERENCES search.identity_receiving_native_plan(partition_no, plan_id);


--
-- Name: identity_receiving_native_operation identity_receiving_native_operation_partition_no_hold_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_operation
    ADD CONSTRAINT identity_receiving_native_operation_partition_no_hold_id_fkey FOREIGN KEY (partition_no, hold_id) REFERENCES search.identity_receiving_native_hold(partition_no, hold_id);


--
-- Name: identity_receiving_native_pending identity_receiving_native_pending_partition_no_plan_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_pending
    ADD CONSTRAINT identity_receiving_native_pending_partition_no_plan_id_fkey FOREIGN KEY (partition_no, plan_id) REFERENCES search.identity_receiving_native_plan(partition_no, plan_id);


--
-- Name: identity_receiving_native_scope_pending identity_receiving_native_sco_partition_no_job_id_effect_k_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_receiving_native_scope_pending
    ADD CONSTRAINT identity_receiving_native_sco_partition_no_job_id_effect_k_fkey FOREIGN KEY (partition_no, job_id, effect_key) REFERENCES semantic.identity_epoch_receiving_plan(partition_no, job_id, effect_key);


--
-- Name: index_incarnation index_incarnation_partition_no_prefix_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_partition_no_prefix_fkey FOREIGN KEY (partition_no, prefix) REFERENCES search.index_prefix_control(partition_no, prefix);


--
-- Name: public_filter_ack_home_clock public_filter_ack_home_clock_partition_no_registration_boo_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_home_clock
    ADD CONSTRAINT public_filter_ack_home_clock_partition_no_registration_boo_fkey FOREIGN KEY (partition_no, registration, bootstrap) REFERENCES search.public_filter_coverage_preparation(partition_no, registration, bootstrap) ON DELETE CASCADE;


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_partition_no_bootstrap_executio_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_partition_no_bootstrap_executio_fkey FOREIGN KEY (partition_no, bootstrap, execution, terminal) REFERENCES semantic.public_filter_repair_step(partition_no, bootstrap, execution, step);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_partition_no_job_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_partition_no_job_fkey FOREIGN KEY (partition_no, job) REFERENCES search.generation_publication(partition_no, job);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_partition_no_observation_execu_fkey1; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_partition_no_observation_execu_fkey1 FOREIGN KEY (partition_no, observation, execution) REFERENCES search.public_filter_repair_verification(partition_no, observation, execution);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_partition_no_observation_execut_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_partition_no_observation_execut_fkey FOREIGN KEY (partition_no, observation, execution) REFERENCES search.public_filter_execution(partition_no, observation, id);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_partition_no_registration_boots_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_partition_no_registration_boots_fkey FOREIGN KEY (partition_no, registration, bootstrap) REFERENCES search.public_filter_coverage_preparation(partition_no, registration, bootstrap);


--
-- Name: public_filter_ack_manifest public_filter_ack_manifest_root_revision_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_manifest
    ADD CONSTRAINT public_filter_ack_manifest_root_revision_fkey FOREIGN KEY (root_revision) REFERENCES search.public_filter_ack_range(revision);


--
-- Name: public_filter_ack_range public_filter_ack_range_left_child_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_range
    ADD CONSTRAINT public_filter_ack_range_left_child_fkey FOREIGN KEY (left_child) REFERENCES search.public_filter_ack_range(revision);


--
-- Name: public_filter_ack_range public_filter_ack_range_partition_no_job_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_range
    ADD CONSTRAINT public_filter_ack_range_partition_no_job_fkey FOREIGN KEY (partition_no, job) REFERENCES search.generation_publication(partition_no, job) ON DELETE CASCADE;


--
-- Name: public_filter_ack_range public_filter_ack_range_partition_no_registration_bootstra_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_range
    ADD CONSTRAINT public_filter_ack_range_partition_no_registration_bootstra_fkey FOREIGN KEY (partition_no, registration, bootstrap) REFERENCES search.public_filter_coverage_preparation(partition_no, registration, bootstrap) ON DELETE CASCADE;


--
-- Name: public_filter_ack_range public_filter_ack_range_right_child_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_ack_range
    ADD CONSTRAINT public_filter_ack_range_right_child_fkey FOREIGN KEY (right_child) REFERENCES search.public_filter_ack_range(revision);


--
-- Name: public_filter_coverage_baseline public_filter_baseline_current_home; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_baseline
    ADD CONSTRAINT public_filter_baseline_current_home FOREIGN KEY (partition_no, registration, source_home) REFERENCES search.public_filter_coverage_home(partition_no, registration, source_home) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: public_filter_coverage_baseline public_filter_coverage_baseline_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_baseline
    ADD CONSTRAINT public_filter_coverage_baseline_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_coverage_home public_filter_coverage_home_baseline; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_home
    ADD CONSTRAINT public_filter_coverage_home_baseline FOREIGN KEY (partition_no, registration, baseline_bootstrap, source_home) REFERENCES search.public_filter_coverage_baseline(partition_no, registration, bootstrap, source_home);


--
-- Name: public_filter_coverage_home public_filter_coverage_home_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_home
    ADD CONSTRAINT public_filter_coverage_home_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_coverage_page public_filter_coverage_page_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_page
    ADD CONSTRAINT public_filter_coverage_page_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_coverage_page public_filter_coverage_page_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_page
    ADD CONSTRAINT public_filter_coverage_page_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_coverage_preparation public_filter_coverage_preparati_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_preparation
    ADD CONSTRAINT public_filter_coverage_preparati_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_execution public_filter_execution_page_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_execution
    ADD CONSTRAINT public_filter_execution_page_fkey FOREIGN KEY (partition_no, page_id) REFERENCES search.public_filter_coverage_page(partition_no, id);


--
-- Name: public_filter_execution public_filter_execution_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_execution
    ADD CONSTRAINT public_filter_execution_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_observation public_filter_observation_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_observation
    ADD CONSTRAINT public_filter_observation_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_pit_claim public_filter_pit_claim_partition_no_bootstrap_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit_claim
    ADD CONSTRAINT public_filter_pit_claim_partition_no_bootstrap_fkey FOREIGN KEY (partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap);


--
-- Name: public_filter_pit_claim public_filter_pit_claim_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit_claim
    ADD CONSTRAINT public_filter_pit_claim_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_pit public_filter_pit_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit
    ADD CONSTRAINT public_filter_pit_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_preparation_segment public_filter_preparation_seg_partition_no_registration_bu_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_preparation_segment
    ADD CONSTRAINT public_filter_preparation_seg_partition_no_registration_bu_fkey FOREIGN KEY (partition_no, registration, build, generation) REFERENCES search.public_filter_prepared(partition_no, registration, build, generation);


--
-- Name: public_filter_prepared public_filter_prepared_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_prepared
    ADD CONSTRAINT public_filter_prepared_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_prepared public_filter_prepared_population_job_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_prepared
    ADD CONSTRAINT public_filter_prepared_population_job_fkey FOREIGN KEY (partition_no, population_job) REFERENCES search.generation_publication(partition_no, job);


--
-- Name: public_filter_reference public_filter_reference_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_reference
    ADD CONSTRAINT public_filter_reference_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_registration public_filter_registration_partition_no_physical_target_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_registration
    ADD CONSTRAINT public_filter_registration_partition_no_physical_target_fkey FOREIGN KEY (partition_no, physical_target) REFERENCES search.public_filter_target(partition_no, physical_target);


--
-- Name: public_filter_repair_effect public_filter_repair_effect_partition_no_observation_execu_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_effect
    ADD CONSTRAINT public_filter_repair_effect_partition_no_observation_execu_fkey FOREIGN KEY (partition_no, observation, execution, page) REFERENCES search.public_filter_repair_page(partition_no, observation, execution, ordinal);


--
-- Name: public_filter_repair_page public_filter_repair_page_partition_no_observation_executi_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_page
    ADD CONSTRAINT public_filter_repair_page_partition_no_observation_executi_fkey FOREIGN KEY (partition_no, observation, execution) REFERENCES search.public_filter_execution(partition_no, observation, id);


--
-- Name: public_filter_repair_subject public_filter_repair_subject_partition_no_observation_exec_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_subject
    ADD CONSTRAINT public_filter_repair_subject_partition_no_observation_exec_fkey FOREIGN KEY (partition_no, observation, execution) REFERENCES search.public_filter_repair_verification(partition_no, observation, execution);


--
-- Name: public_filter_repair_verification public_filter_repair_verifica_partition_no_observation_exe_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_verification
    ADD CONSTRAINT public_filter_repair_verifica_partition_no_observation_exe_fkey FOREIGN KEY (partition_no, observation, execution) REFERENCES search.public_filter_execution(partition_no, observation, id) ON DELETE CASCADE;


--
-- Name: recent_search recent_search_partition_no_route_account_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_partition_no_route_account_id_fkey FOREIGN KEY (partition_no, route, account_id) REFERENCES search.recent_search_state(partition_no, route, account_id) ON DELETE CASCADE;


--
-- Name: release_relevance_membership_node release_relevance_membership_node_execution_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.release_relevance_membership_node
    ADD CONSTRAINT release_relevance_membership_node_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES search.release_relevance_execution(id) ON DELETE CASCADE;


--
-- Name: release_relevance_position release_relevance_position_execution_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.release_relevance_position
    ADD CONSTRAINT release_relevance_position_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES search.release_relevance_execution(id) ON DELETE CASCADE;


--
-- Name: release_relevance_position release_relevance_position_membership_root_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.release_relevance_position
    ADD CONSTRAINT release_relevance_position_membership_root_fkey FOREIGN KEY (execution_id, membership_root) REFERENCES search.release_relevance_membership_node(execution_id, id);


--
-- Name: retained_copy_lane retained_copy_lane_partition_no_physical_target_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.retained_copy_lane
    ADD CONSTRAINT retained_copy_lane_partition_no_physical_target_fkey FOREIGN KEY (partition_no, physical_target) REFERENCES search.public_filter_target(partition_no, physical_target);


--
-- Name: subject_privacy_intake_v1 subject_privacy_intake_v1_input_key_birth_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_privacy_intake_v1
    ADD CONSTRAINT subject_privacy_intake_v1_input_key_birth_fkey FOREIGN KEY (input_key, birth) REFERENCES core.subject_subscription_key_v1(input_key, birth);


--
-- Name: subject_privacy_intake_v1 subject_privacy_intake_v1_partition_no_input_key_enqueue_r_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_privacy_intake_v1
    ADD CONSTRAINT subject_privacy_intake_v1_partition_no_input_key_enqueue_r_fkey FOREIGN KEY (partition_no, input_key, enqueue_revision) REFERENCES semantic.subject_privacy_fanout_v1(partition_no, input_key, enqueue_revision);


--
-- Name: subject_receiver_dirty_v1 subject_receiver_dirty_v1_birth_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_receiver_dirty_v1
    ADD CONSTRAINT subject_receiver_dirty_v1_birth_fkey FOREIGN KEY (birth) REFERENCES core.subject_subscription_v1(birth);


--
-- Name: subject_receiver_page_v1 subject_receiver_page_v1_birth_first_home_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.subject_receiver_page_v1
    ADD CONSTRAINT subject_receiver_page_v1_birth_first_home_fkey FOREIGN KEY (birth, first_home) REFERENCES core.subject_retention_page_v1(birth, first_home);


--
-- Name: trending_member trending_member_route_term_key_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_member
    ADD CONSTRAINT trending_member_route_term_key_fkey FOREIGN KEY (route, term_key) REFERENCES search.trending_term(route, term_key) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


