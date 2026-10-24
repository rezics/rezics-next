-- Invalidation precedes the authoritative head change. Its durable cursor visits
-- effective people, never all the other people sharing an origin Main Version.
-- Delivery uses the existing job and releases the same local publication holds.
ALTER TABLE access.rating_standing_refresh
  ADD COLUMN phase text NOT NULL DEFAULT 'deliver' CHECK(phase IN ('invalidate','prepared','deliver')),
  ADD COLUMN mutation text;
CREATE INDEX rating_standing_refresh_ready ON access.rating_standing_refresh(context,origin_main_version,origin_slot)
  WHERE phase<>'prepared';
CREATE INDEX rating_standing_refresh_admission ON access.rating_standing_refresh((left(mutation,36))) WHERE mutation IS NOT NULL;
CREATE INDEX rating_standing_inherited_person ON access.rating_standing_contribution
  (context,origin_main_version,origin_slot,main_version) WHERE merge_lineage IS NOT NULL;

CREATE FUNCTION access.rating_standing_projection_key(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'standing-origin:'||s;
$$;
CREATE FUNCTION access.rating_standing_head_key(a uuid,v numeric,k boolean,deleting boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT a::text||':'||encode(sha256(convert_to(jsonb_build_array(trim_scale(v),k,deleting)::text,'UTF8')),'hex');
$$;

CREATE FUNCTION access.advance_rating_standing_invalidation(c text,o text,s text,page_limit integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE job access.rating_standing_refresh%ROWTYPE; r record; last_key text;
BEGIN
  SELECT * INTO job FROM access.rating_standing_refresh
    WHERE (context,origin_main_version,origin_slot)=(c,o,s) FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF job.phase<>'invalidate' THEN RETURN job.phase='prepared'; END IF;
  last_key:=job.after_main_version;
  FOR r IN SELECT main_version FROM access.rating_standing_contribution
    WHERE context=c AND origin_main_version=o AND origin_slot=s AND merge_lineage IS NOT NULL
      AND main_version>job.after_main_version
    ORDER BY main_version LIMIT LEAST(GREATEST(page_limit,0),100) FOR SHARE LOOP
    PERFORM access.rating_standing_hold(c,r.main_version,access.rating_standing_projection_key(s));
    last_key:=r.main_version;
  END LOOP;
  -- The exhaustion probe is another indexed seek, including for an empty page.
  IF NOT EXISTS(SELECT 1 FROM access.rating_standing_contribution
    WHERE context=c AND origin_main_version=o AND origin_slot=s AND merge_lineage IS NOT NULL
      AND main_version>last_key ORDER BY main_version LIMIT 1) THEN
    UPDATE access.rating_standing_refresh SET phase='prepared',after_main_version=''
      WHERE (context,origin_main_version,origin_slot)=(c,o,s);
    RETURN true;
  END IF;
  UPDATE access.rating_standing_refresh SET after_main_version=last_key
    WHERE (context,origin_main_version,origin_slot)=(c,o,s);
  RETURN false;
END $$;

-- The source gate also covers subscriptions to a currently absent origin head.
-- A subscription behind the cursor installs its own hold before it can commit.
CREATE FUNCTION access.prepare_rating_standing_head_change(c text,o text,s text,change_key text,page_limit integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE job access.rating_standing_refresh%ROWTYPE;
BEGIN
  INSERT INTO access.rating_observation_gate(context,target) VALUES(c,o) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM access.rating_observation_gate WHERE context=c AND target=o FOR UPDATE;
  SELECT * INTO job FROM access.rating_standing_refresh
    WHERE (context,origin_main_version,origin_slot)=(c,o,s) FOR UPDATE;
  -- A different admission cannot replace a pre-effect binding: cancelling it
  -- would otherwise release another admission's already dispatched graph cut.
  IF FOUND AND job.phase<>'deliver' AND job.mutation IS DISTINCT FROM change_key THEN RETURN false; END IF;
  IF NOT FOUND OR job.mutation IS DISTINCT FROM change_key OR job.phase='deliver' THEN
    INSERT INTO access.rating_standing_refresh
      (context,origin_main_version,origin_slot,after_main_version,after_principal_id,phase,mutation)
      VALUES(c,o,s,'','00000000-0000-0000-0000-000000000000','invalidate',change_key)
      ON CONFLICT(context,origin_main_version,origin_slot) DO UPDATE SET
        after_main_version='',after_principal_id=EXCLUDED.after_principal_id,phase='invalidate',mutation=change_key;
    PERFORM access.rating_standing_hold(c,o,access.rating_standing_projection_key(s));
  ELSIF job.phase='prepared' THEN RETURN true;
  END IF;
  RETURN access.advance_rating_standing_invalidation(c,o,s,page_limit);
END $$;

CREATE FUNCTION access.rating_standing_head_changing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE:=COALESCE(NEW,OLD); change_key text;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.context,OLD.main_version,OLD.slot,OLD.principal_id,OLD.work,OLD.observation,
      OLD.original_admission_id,OLD.target_release) IS DISTINCT FROM
    (NEW.context,NEW.main_version,NEW.slot,NEW.principal_id,NEW.work,NEW.observation,NEW.original_admission_id,NEW.target_release) THEN
    RAISE EXCEPTION 'Rating head identity is immutable';
  END IF;
  IF h.target_release IS NOT NULL OR h.slot<>access.rating_standing_slot(h.principal_id,h.context,h.main_version) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  change_key:=access.rating_standing_head_key(h.admission_id,h.value,h.value_known,TG_OP='DELETE');
  -- Ordinary zero/one-projection mutations finish preparation in this statement.
  -- Larger mutations must commit bounded preparation before attempting the effect.
  IF NOT access.prepare_rating_standing_head_change(h.context,h.main_version,h.slot,change_key,1) THEN
    RAISE EXCEPTION 'Standing head invalidation requires bounded continuation';
  END IF;
  UPDATE access.rating_standing_refresh SET phase='deliver',after_main_version='',
    after_principal_id='00000000-0000-0000-0000-000000000000'
    WHERE (context,origin_main_version,origin_slot)=(h.context,h.main_version,h.slot);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER rating_standing_head_changing BEFORE INSERT OR UPDATE OR DELETE ON access.rating_aggregate_head
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_head_changing();

-- A terminal cancellation proves that this admission applied no graph effect.
-- Release the source immediately; affected subscriptions settle in ordinary
-- delivery pages against the unchanged head, including no-op refreshes.
CREATE FUNCTION access.cancel_rating_standing_head_change(a uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE job access.rating_standing_refresh%ROWTYPE;
BEGIN
  SELECT * INTO job FROM access.rating_standing_refresh WHERE mutation IS NOT NULL AND left(mutation,36)=a::text
    ORDER BY context,origin_main_version,origin_slot LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM access.rating_observation_gate WHERE context=job.context AND target=job.origin_main_version FOR UPDATE;
  UPDATE access.rating_standing_refresh SET phase='deliver',after_main_version='',
    after_principal_id='00000000-0000-0000-0000-000000000000'
    WHERE (context,origin_main_version,origin_slot)=(job.context,job.origin_main_version,job.origin_slot)
      AND mutation=job.mutation AND phase<>'deliver';
  IF FOUND THEN PERFORM access.rating_standing_release(job.context,job.origin_main_version,access.rating_standing_projection_key(job.origin_slot)); END IF;
END $$;

CREATE FUNCTION access.rating_standing_person_pending() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phase text;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.merge_lineage IS NOT NULL AND (TG_OP='DELETE' OR NEW.merge_lineage IS NULL
      OR (OLD.origin_main_version,OLD.origin_slot) IS DISTINCT FROM (NEW.origin_main_version,NEW.origin_slot)) THEN
    PERFORM access.rating_standing_release(OLD.context,OLD.main_version,access.rating_standing_projection_key(OLD.origin_slot));
  END IF;
  IF TG_OP<>'DELETE' AND NEW.merge_lineage IS NOT NULL THEN
    SELECT j.phase INTO phase FROM access.rating_standing_refresh j
      WHERE (j.context,j.origin_main_version,j.origin_slot)=(NEW.context,NEW.origin_main_version,NEW.origin_slot);
    IF phase IN ('invalidate','prepared') THEN
      PERFORM access.rating_standing_hold(NEW.context,NEW.main_version,access.rating_standing_projection_key(NEW.origin_slot));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_person_pending AFTER INSERT OR UPDATE OR DELETE ON access.rating_standing_contribution
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_person_pending();

CREATE OR REPLACE FUNCTION access.refresh_rating_standing_slot(c text,m text,person uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE; s access.rating_merge_selection%ROWTYPE; present boolean; task text;
BEGIN
  INSERT INTO access.rating_observation_gate(context,target) VALUES(c,m) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM access.rating_observation_gate WHERE context=c AND target=m FOR UPDATE;
  SELECT * INTO h FROM access.rating_aggregate_head WHERE context=c AND main_version=m
    AND slot=access.rating_standing_slot(person,c,m) AND target_release IS NULL FOR SHARE;
  present:=FOUND;
  IF NOT present THEN
    SELECT * INTO s FROM access.rating_merge_selection WHERE context=c AND main_version=m AND principal_id=person;
    present:=FOUND;
    IF present THEN
      task:=s.task_key;
      IF access.rating_standing_merge_revoked(c,s.standing_lineage) THEN present:=false;
      ELSE
        INSERT INTO access.rating_observation_gate(context,target) VALUES(c,s.origin_main_version) ON CONFLICT DO NOTHING;
        PERFORM 1 FROM access.rating_observation_gate WHERE context=c AND target=s.origin_main_version FOR SHARE;
        SELECT * INTO h FROM access.rating_aggregate_head WHERE context=c AND main_version=s.origin_main_version
          AND slot=s.origin_slot AND principal_id=person AND target_release IS NULL FOR SHARE;
      END IF;
    END IF;
  END IF;
  IF NOT present THEN
    DELETE FROM access.rating_standing_contribution WHERE context=c AND main_version=m AND principal_id=person;
    RETURN;
  END IF;
  INSERT INTO access.rating_standing_contribution
    (context,main_version,principal_id,effective_slot,origin_main_version,origin_slot,value,value_known,admission_id,merge_task_key,merge_lineage,target_work)
    VALUES(c,m,person,access.rating_standing_slot(person,c,m),COALESCE(h.main_version,s.origin_main_version),
      COALESCE(h.slot,s.origin_slot),h.value,COALESCE(h.value_known,false),h.admission_id,task,s.standing_lineage,
      CASE WHEN task IS NULL THEN h.work ELSE s.work END)
    ON CONFLICT(context,main_version,principal_id) DO UPDATE SET
      origin_main_version=EXCLUDED.origin_main_version,origin_slot=EXCLUDED.origin_slot,
      value=EXCLUDED.value,value_known=EXCLUDED.value_known,admission_id=EXCLUDED.admission_id,
      merge_task_key=EXCLUDED.merge_task_key,merge_lineage=EXCLUDED.merge_lineage,target_work=EXCLUDED.target_work
    WHERE (rating_standing_contribution.origin_main_version,rating_standing_contribution.origin_slot,
      rating_standing_contribution.value,rating_standing_contribution.value_known,rating_standing_contribution.admission_id,
      rating_standing_contribution.merge_task_key,rating_standing_contribution.merge_lineage,rating_standing_contribution.target_work) IS DISTINCT FROM
      (EXCLUDED.origin_main_version,EXCLUDED.origin_slot,EXCLUDED.value,EXCLUDED.value_known,EXCLUDED.admission_id,
      EXCLUDED.merge_task_key,EXCLUDED.merge_lineage,EXCLUDED.target_work);
  -- A no-op refresh still settles delivery, but verification during preparation
  -- cannot release a fence before the separately committed authoritative effect.
  IF task IS NOT NULL AND EXISTS(SELECT 1 FROM access.rating_standing_refresh j
    WHERE (j.context,j.origin_main_version,j.origin_slot)=(c,s.origin_main_version,s.origin_slot) AND j.phase='deliver') THEN
    PERFORM access.rating_standing_release(c,m,access.rating_standing_projection_key(s.origin_slot));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION access.rating_standing_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE:=COALESCE(NEW,OLD); first_target access.rating_merge_selection%ROWTYPE; more boolean;
BEGIN
  IF h.target_release IS NOT NULL OR h.slot<>access.rating_standing_slot(h.principal_id,h.context,h.main_version) THEN RETURN NULL; END IF;
  PERFORM access.refresh_rating_standing_slot(h.context,h.main_version,h.principal_id);
  SELECT s.* INTO first_target FROM access.rating_merge_selection s
    WHERE s.context=h.context AND s.origin_main_version=h.main_version AND s.origin_slot=h.slot
    ORDER BY s.main_version,s.principal_id LIMIT 1;
  IF FOUND THEN
    PERFORM access.refresh_rating_standing_slot(h.context,first_target.main_version,first_target.principal_id);
    SELECT EXISTS(SELECT 1 FROM access.rating_merge_selection s
      WHERE s.context=h.context AND s.origin_main_version=h.main_version AND s.origin_slot=h.slot
        AND (s.main_version,s.principal_id)>(first_target.main_version,first_target.principal_id)
      ORDER BY s.main_version,s.principal_id LIMIT 1) INTO more;
  END IF;
  IF COALESCE(more,false) THEN
    UPDATE access.rating_standing_refresh SET after_main_version=first_target.main_version,after_principal_id=first_target.principal_id
      WHERE (context,origin_main_version,origin_slot)=(h.context,h.main_version,h.slot);
  ELSE DELETE FROM access.rating_standing_refresh
    WHERE (context,origin_main_version,origin_slot)=(h.context,h.main_version,h.slot);
  END IF;
  PERFORM access.rating_standing_release(h.context,h.main_version,access.rating_standing_projection_key(h.slot));
  RETURN NULL;
END $$;

-- Upgrade existing delivery jobs without dropping their unpublished evidence.
-- This one-time reconciliation is not a request-time origin or population scan.
SELECT access.rating_standing_hold(k.context,k.main_version,access.rating_standing_projection_key(k.origin_slot))
  FROM access.rating_standing_contribution k JOIN access.rating_standing_refresh j
    ON (j.context,j.origin_main_version,j.origin_slot)=(k.context,k.origin_main_version,k.origin_slot)
  WHERE k.merge_lineage IS NOT NULL AND (k.main_version,k.principal_id)>(j.after_main_version,j.after_principal_id);

CREATE OR REPLACE FUNCTION access.rating_standing_publication_state(c text,m text,
  OUT generation text,OUT pending bigint,OUT slots integer,OUT unvalued integer,
  OUT histogram jsonb,OUT last_admission_id uuid)
LANGUAGE sql STABLE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',c,m,
      COALESCE(k.publication_revision::text,'0'),COALESCE(f.revision::text,'0')),'UTF8')),'hex'),
    CASE WHEN COALESCE(f.pending,0)>0
      OR EXISTS(SELECT 1 FROM access.rating_standing_bootstrap WHERE context=c AND main_version=m)
      THEN 1::bigint ELSE 0::bigint END,k.slots,k.unvalued,k.histogram,k.last_admission_id
  FROM (VALUES(1)) one_row(n)
  LEFT JOIN LATERAL(SELECT main_version,publication_revision,slots,unvalued,histogram,last_admission_id
    FROM access.rating_standing_component WHERE context=c AND main_version>=m ORDER BY main_version LIMIT 1) k ON k.main_version=m
  LEFT JOIN LATERAL(SELECT main_version,revision,pending FROM access.rating_standing_cut
    WHERE context=c AND main_version>=m ORDER BY main_version LIMIT 1) f ON f.main_version=m;
$$;
