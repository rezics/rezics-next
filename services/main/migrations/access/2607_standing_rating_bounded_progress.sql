-- Discovery is owner work, not part of a population read or a row trigger.
-- A pre-identity fence is prepared in durable pages before graph effects.
-- Each unit visits one context, dependency, lineage edge or selection.
ALTER TABLE access.rating_standing_transition ADD COLUMN prepared boolean NOT NULL DEFAULT false;
ALTER TABLE access.rating_standing_lineage ADD COLUMN revoked_by text, ADD COLUMN bootstrap boolean NOT NULL DEFAULT false;
ALTER TABLE access.rating_standing_dependency ADD COLUMN inherited_slots bigint NOT NULL DEFAULT 0;
UPDATE access.rating_standing_dependency d SET inherited_slots=x.n FROM (
  SELECT context,main_version,origin_main_version,count(*) AS n
  FROM access.rating_standing_contribution WHERE merge_lineage IS NOT NULL
  GROUP BY context,main_version,origin_main_version
) x WHERE (d.context,d.main_version,d.kind,d.dependency)=(x.context,x.main_version,'origin',x.origin_main_version);
CREATE INDEX rating_standing_component_contexts ON access.rating_standing_component(main_version,context) WHERE slots>0;
CREATE INDEX rating_standing_dependency_reverse ON access.rating_standing_dependency(kind,dependency,context,main_version);
CREATE INDEX rating_standing_dependency_inherited ON access.rating_standing_dependency(context,main_version,dependency)
  WHERE kind='origin' AND inherited_slots>0;
CREATE INDEX rating_standing_refresh_delivery ON access.rating_standing_refresh(context,origin_main_version,after_main_version);
CREATE INDEX rating_standing_transition_open_origin ON access.rating_standing_transition(source_main_version,task_key) WHERE NOT finished;

CREATE TABLE access.rating_standing_cut (
  context text NOT NULL, main_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 0, pending bigint NOT NULL DEFAULT 0 CHECK(pending>=0),
  PRIMARY KEY(context,main_version)
);
CREATE TABLE access.rating_standing_cut_fence (
  context text NOT NULL, main_version text NOT NULL, task_key text NOT NULL,
  PRIMARY KEY(context,main_version,task_key)
);
CREATE INDEX rating_standing_cut_fence_release ON access.rating_standing_cut_fence(task_key,context,main_version);
CREATE TABLE access.rating_standing_progress (
  task_key text PRIMARY KEY, phase text NOT NULL CHECK(phase IN ('contexts','origins','roots','walk','wait','cleanup','release')),
  after_context text NOT NULL DEFAULT '', after_key text NOT NULL DEFAULT '', legacy boolean NOT NULL DEFAULT false
);
CREATE INDEX rating_standing_progress_ready ON access.rating_standing_progress(task_key) WHERE phase<>'wait';
CREATE INDEX rating_standing_progress_bootstrap ON access.rating_standing_progress(phase,task_key) WHERE legacy;
CREATE TABLE access.rating_standing_bootstrap (
  context text NOT NULL, main_version text NOT NULL, PRIMARY KEY(context,main_version)
);
CREATE TABLE access.rating_standing_walk (
  task_key text NOT NULL, context text NOT NULL, lineage text NOT NULL,
  phase text NOT NULL CHECK(phase IN ('children','components','wait','cleanup')),
  after_key text NOT NULL DEFAULT '', after_person uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  PRIMARY KEY(task_key,context,lineage)
);
CREATE INDEX rating_standing_walk_phase ON access.rating_standing_walk(task_key,phase,context,lineage);
-- A root is registered before traversal. New children inherit their parent's
-- revocation pointer; new roots check this one retained binding. The pointer
-- never clears merely because a separately committed verification succeeded.
CREATE TABLE access.rating_standing_revocation (
  original_key text PRIMARY KEY, task_key text NOT NULL
);
CREATE TABLE access.rating_standing_registration (
  context text NOT NULL, main_version text NOT NULL, origin_main_version text NOT NULL,
  after_task text NOT NULL DEFAULT '', PRIMARY KEY(context,main_version,origin_main_version)
);

CREATE FUNCTION access.rating_standing_hold(c text,m text,t text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.rating_standing_cut_fence VALUES(c,m,t) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO access.rating_standing_cut VALUES(c,m,1,1)
      ON CONFLICT(context,main_version) DO UPDATE SET
        revision=rating_standing_cut.revision+1,pending=rating_standing_cut.pending+1;
  END IF;
END $$;
CREATE FUNCTION access.rating_standing_release(c text,m text,t text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access.rating_standing_cut_fence WHERE context=c AND main_version=m AND task_key=t;
  IF FOUND THEN UPDATE access.rating_standing_cut SET revision=revision+1,pending=pending-1
    WHERE context=c AND main_version=m; END IF;
END $$;

-- Register a newly effective origin against open transitions in bounded pages.
-- Its local hold remains until the indexed cursor is exhausted. Existing
-- unrelated components need no registration or operator action.
CREATE FUNCTION access.rating_standing_register(c text,m text,o text,page_limit integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; job access.rating_standing_registration%ROWTYPE; n integer:=0;
BEGIN
  SELECT * INTO job FROM access.rating_standing_registration
    WHERE (context,main_version,origin_main_version)=(c,m,o) FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR r IN SELECT task_key,survivor_main_version FROM access.rating_standing_transition
    WHERE source_main_version=o AND NOT finished AND task_key>job.after_task ORDER BY task_key LIMIT LEAST(page_limit,100) FOR SHARE LOOP
    PERFORM access.rating_standing_hold(c,m,r.task_key);
    IF m=o THEN PERFORM access.rating_standing_hold(c,r.survivor_main_version,r.task_key); END IF;
    job.after_task:=r.task_key; n:=n+1;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM access.rating_standing_transition WHERE source_main_version=o AND NOT finished
      AND task_key>job.after_task ORDER BY task_key LIMIT 1) THEN
    DELETE FROM access.rating_standing_registration WHERE (context,main_version,origin_main_version)=(c,m,o);
    UPDATE access.rating_standing_cut SET revision=revision+1,pending=pending-1 WHERE context=c AND main_version=m;
  ELSE UPDATE access.rating_standing_registration SET after_task=job.after_task
    WHERE (context,main_version,origin_main_version)=(c,m,o); END IF;
  RETURN n;
END $$;
CREATE FUNCTION access.rating_standing_register_origin(c text,m text,o text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.rating_standing_registration VALUES(c,m,o,'') ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO access.rating_standing_cut VALUES(c,m,1,1) ON CONFLICT(context,main_version) DO UPDATE SET
      revision=rating_standing_cut.revision+1,pending=rating_standing_cut.pending+1;
    PERFORM access.rating_standing_register(c,m,o,1);
  END IF;
END $$;

CREATE FUNCTION access.rating_standing_queue_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.finished AND NEW.original_key IS NULL THEN RETURN NULL; END IF;
  INSERT INTO access.rating_standing_progress(task_key,phase) VALUES(NEW.task_key,'contexts') ON CONFLICT DO NOTHING;
  IF NEW.original_key IS NOT NULL THEN
    INSERT INTO access.rating_standing_revocation VALUES(NEW.original_key,NEW.task_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_queue_transition AFTER INSERT ON access.rating_standing_transition
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_queue_transition();

CREATE FUNCTION access.rating_standing_mark_lineage(t text,c text,p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.rating_standing_lineage SET revoked_by=COALESCE(revoked_by,t) WHERE context=c AND lineage=p;
  INSERT INTO access.rating_standing_walk(task_key,context,lineage,phase) VALUES(t,c,p,'children') ON CONFLICT DO NOTHING;
END $$;

-- page_limit counts discovery as well as mutations, including exhausted probes.
-- No recursive CTE, whole-history aggregate or pre-LIMIT sort is hidden here.
CREATE FUNCTION access.advance_rating_standing_transition(t text,page_limit integer,cleanup_allowed boolean DEFAULT true)
RETURNS TABLE(steps integer,prepared boolean,refreshed integer) LANGUAGE plpgsql AS $$
DECLARE job access.rating_standing_progress%ROWTYPE; cut access.rating_standing_transition%ROWTYPE;
  node access.rating_standing_walk%ROWTYPE; r record; i integer;
BEGIN
  steps:=0; refreshed:=0;
  -- Serialize this task's state machine before its cursor; concurrent preparers
  -- must not hold shared task locks while waiting to upgrade the same row.
  SELECT * INTO cut FROM access.rating_standing_transition WHERE task_key=t FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Standing transition is unavailable'; END IF;
  SELECT * INTO job FROM access.rating_standing_progress WHERE task_key=t FOR UPDATE;
  IF NOT FOUND THEN prepared:=cut.prepared; RETURN NEXT; RETURN; END IF;
  FOR i IN 1..LEAST(GREATEST(page_limit,0),100) LOOP
    steps:=steps+1;
    IF job.phase='contexts' THEN
      SELECT context INTO r FROM access.rating_standing_component WHERE main_version=cut.source_main_version
        AND slots>0 AND context>job.after_context ORDER BY context LIMIT 1;
      IF FOUND THEN
        PERFORM access.rating_standing_hold(r.context,cut.source_main_version,t);
        PERFORM access.rating_standing_hold(r.context,cut.survivor_main_version,t);
        job.after_context:=r.context;
      ELSE job.phase:='origins'; job.after_context:=''; job.after_key:=''; END IF;
    ELSIF job.phase='origins' THEN
      SELECT context,main_version INTO r FROM access.rating_standing_dependency WHERE kind='origin'
        AND dependency=cut.source_main_version AND (context,main_version)>(job.after_context,job.after_key)
        ORDER BY context,main_version LIMIT 1;
      IF FOUND THEN
        PERFORM access.rating_standing_hold(r.context,r.main_version,t);
        job.after_context:=r.context; job.after_key:=r.main_version;
      ELSE job.phase:='roots'; job.after_context:=''; job.after_key:=''; END IF;
    ELSIF job.phase='roots' THEN
      SELECT context,lineage INTO r FROM access.rating_standing_lineage WHERE task_key=cut.original_key
        AND (context,lineage)>(job.after_context,job.after_key) ORDER BY context,lineage LIMIT 1;
      IF FOUND THEN
        PERFORM access.rating_standing_mark_lineage(t,r.context,r.lineage);
        job.after_context:=r.context; job.after_key:=r.lineage;
      ELSE job.phase:='walk'; END IF;
    ELSIF job.phase='walk' THEN
      SELECT * INTO node FROM access.rating_standing_walk WHERE task_key=t AND phase='children'
        ORDER BY context,lineage LIMIT 1 FOR UPDATE;
      IF NOT FOUND THEN SELECT * INTO node FROM access.rating_standing_walk WHERE task_key=t AND phase='components'
        ORDER BY context,lineage LIMIT 1 FOR UPDATE; END IF;
      IF NOT FOUND THEN
        UPDATE access.rating_standing_transition SET prepared=true WHERE task_key=t;
        job.phase:=CASE WHEN cut.finished THEN 'cleanup' ELSE 'wait' END;
      ELSIF node.phase='children' THEN
        SELECT lineage INTO r FROM access.rating_standing_lineage WHERE context=node.context AND parent_lineage=node.lineage
          AND lineage>node.after_key ORDER BY lineage LIMIT 1;
        IF FOUND THEN
          PERFORM access.rating_standing_mark_lineage(t,node.context,r.lineage);
          UPDATE access.rating_standing_walk SET after_key=r.lineage
            WHERE (task_key,context,lineage)=(t,node.context,node.lineage);
        ELSE UPDATE access.rating_standing_walk SET phase='components',after_key=''
          WHERE (task_key,context,lineage)=(t,node.context,node.lineage); END IF;
      ELSE
        SELECT main_version INTO r FROM access.rating_standing_dependency WHERE kind='merge' AND dependency=node.lineage
          AND context=node.context AND main_version>node.after_key ORDER BY main_version LIMIT 1;
        IF FOUND THEN
          PERFORM access.rating_standing_hold(node.context,r.main_version,t);
          UPDATE access.rating_standing_walk SET after_key=r.main_version
            WHERE (task_key,context,lineage)=(t,node.context,node.lineage);
        ELSE UPDATE access.rating_standing_walk SET phase='wait',after_key=''
          WHERE (task_key,context,lineage)=(t,node.context,node.lineage); END IF;
      END IF;
    ELSIF job.phase='wait' THEN EXIT;
    ELSIF job.phase='cleanup' THEN
      SELECT * INTO node FROM access.rating_standing_walk WHERE task_key=t AND phase='cleanup'
        ORDER BY context,lineage LIMIT 1 FOR UPDATE;
      IF NOT FOUND THEN SELECT * INTO node FROM access.rating_standing_walk WHERE task_key=t AND phase='wait'
        ORDER BY context,lineage LIMIT 1 FOR UPDATE; END IF;
      IF NOT FOUND THEN job.phase:='release';
      ELSE
        SELECT main_version,principal_id INTO r FROM access.rating_merge_selection
          WHERE context=node.context AND standing_lineage=node.lineage
            AND (main_version,principal_id)>(node.after_key,node.after_person)
          ORDER BY main_version,principal_id LIMIT 1 FOR UPDATE;
        IF FOUND THEN
          -- Completion may release already consistent cuts, but does not hide
          -- a projection mutation page inside the identity journal trigger.
          IF NOT cleanup_allowed THEN EXIT; END IF;
          PERFORM 1 FROM access.scope_gate WHERE id='rating:observe:'||node.context FOR SHARE;
          DELETE FROM access.rating_merge_selection WHERE (context,main_version,principal_id)=(node.context,r.main_version,r.principal_id);
          refreshed:=refreshed+1;
          UPDATE access.rating_standing_walk SET phase='cleanup',after_key=r.main_version,after_person=r.principal_id
            WHERE (task_key,context,lineage)=(t,node.context,node.lineage);
        ELSE DELETE FROM access.rating_standing_walk WHERE (task_key,context,lineage)=(t,node.context,node.lineage); END IF;
      END IF;
    ELSE
      SELECT context,main_version INTO r FROM access.rating_standing_cut_fence WHERE task_key=t
        ORDER BY context,main_version LIMIT 1;
      IF FOUND THEN PERFORM access.rating_standing_release(r.context,r.main_version,t);
      ELSE DELETE FROM access.rating_standing_progress WHERE task_key=t; EXIT; END IF;
    END IF;
    UPDATE access.rating_standing_progress SET phase=job.phase,after_context=job.after_context,after_key=job.after_key WHERE task_key=t;
  END LOOP;
  SELECT f.prepared INTO prepared FROM access.rating_standing_transition f WHERE f.task_key=t;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION access.rating_standing_transition_finished() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.rating_standing_transition SET finished=true WHERE task_key=NEW.task_key;
  UPDATE access.rating_standing_progress SET phase='cleanup' WHERE task_key=NEW.task_key AND phase='wait';
  PERFORM access.advance_rating_standing_transition(NEW.task_key,100,false);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.rating_standing_merge_revoked(c text,path text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT t.finished FROM access.rating_standing_lineage l
    JOIN access.rating_standing_transition t ON t.task_key=l.revoked_by WHERE l.context=c AND l.lineage=path),false);
$$;

CREATE OR REPLACE FUNCTION access.rating_standing_selection_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; parent_task text; parent text; path text; recorded text; revoker text; boot boolean:=false; done boolean;
BEGIN
  SELECT before_state::jsonb INTO b FROM access.identity_merge_item
    WHERE task_key=NEW.task_key AND owner='rating' AND item_key=NEW.principal_id::text||'|'||NEW.context;
  IF b #>> '{source,head,main_version}'=b #>> '{source,selection,origin_main_version}'
    AND b #>> '{source,head,slot}'=b #>> '{source,selection,origin_slot}' THEN
    parent_task:=b #>> '{source,selection,task_key}';
    SELECT lineage INTO parent FROM access.rating_standing_lineage_member
      WHERE context=NEW.context AND task_key=parent_task AND principal_id=NEW.principal_id;
    IF parent_task IS NOT NULL AND parent IS NULL THEN RAISE EXCEPTION 'Standing rating parent lineage is unavailable'; END IF;
  END IF;
  IF parent IS NOT NULL THEN
    SELECT revoked_by,bootstrap INTO revoker,boot FROM access.rating_standing_lineage WHERE context=NEW.context AND lineage=parent FOR SHARE;
  END IF;
  IF revoker IS NULL THEN SELECT task_key INTO revoker FROM access.rating_standing_revocation WHERE original_key=NEW.task_key; END IF;
  path:=encode(sha256(convert_to(jsonb_build_array(NEW.task_key,parent)::text,'UTF8')),'hex');
  INSERT INTO access.rating_standing_lineage(context,lineage,task_key,parent_lineage,revoked_by,bootstrap)
    VALUES(NEW.context,path,NEW.task_key,parent,revoker,boot) ON CONFLICT DO NOTHING;
  INSERT INTO access.rating_standing_lineage_member VALUES(NEW.context,NEW.task_key,NEW.principal_id,path) ON CONFLICT DO NOTHING;
  SELECT lineage INTO recorded FROM access.rating_standing_lineage_member
    WHERE context=NEW.context AND task_key=NEW.task_key AND principal_id=NEW.principal_id;
  IF recorded<>path THEN RAISE EXCEPTION 'Standing rating retained lineage changed'; END IF;
  SELECT revoked_by,bootstrap INTO revoker,boot FROM access.rating_standing_lineage
    WHERE context=NEW.context AND lineage=path FOR SHARE;
  IF boot AND EXISTS(SELECT 1 FROM access.rating_standing_progress WHERE legacy AND phase IN ('contexts','origins','roots','walk') LIMIT 1) THEN
    INSERT INTO access.rating_standing_bootstrap VALUES(NEW.context,NEW.main_version) ON CONFLICT DO NOTHING;
  END IF;
  IF revoker IS NOT NULL THEN
    PERFORM access.rating_standing_hold(NEW.context,NEW.main_version,revoker);
    INSERT INTO access.rating_standing_walk(task_key,context,lineage,phase) VALUES(revoker,NEW.context,path,'wait') ON CONFLICT DO NOTHING;
    SELECT finished INTO done FROM access.rating_standing_transition WHERE task_key=revoker;
    INSERT INTO access.rating_standing_progress(task_key,phase) VALUES(revoker,CASE WHEN done THEN 'cleanup' ELSE 'wait' END)
      ON CONFLICT(task_key) DO UPDATE SET phase=CASE WHEN rating_standing_progress.phase='release' THEN 'cleanup' ELSE rating_standing_progress.phase END;
  END IF;
  NEW.standing_lineage:=path;
  RETURN NEW;
END $$;

-- Replace recursive completion checks with the indexed live work set. Finished
-- history is retained in its existing journal, never rediscovered on exhaustion.
CREATE OR REPLACE FUNCTION access.cleanup_rating_standing_projections(c text,page_limit integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; n integer:=0;
BEGIN
  IF c IS NULL THEN
    SELECT context,main_version,origin_main_version INTO r FROM access.rating_standing_registration
      ORDER BY context,main_version,origin_main_version LIMIT 1;
  ELSE
    SELECT context,main_version,origin_main_version INTO r FROM access.rating_standing_registration
      WHERE context=c ORDER BY main_version,origin_main_version LIMIT 1;
  END IF;
  IF FOUND THEN PERFORM access.rating_standing_register(r.context,r.main_version,r.origin_main_version,page_limit); RETURN 0; END IF;
  SELECT task_key INTO r FROM access.rating_standing_progress WHERE phase<>'wait' ORDER BY task_key LIMIT 1;
  IF FOUND THEN SELECT refreshed INTO n FROM access.advance_rating_standing_transition(r.task_key,page_limit);
  ELSIF NOT EXISTS(SELECT 1 FROM access.rating_standing_progress WHERE legacy AND phase IN ('contexts','origins','roots','walk') LIMIT 1) THEN
    WITH page AS ((SELECT context,main_version FROM access.rating_standing_bootstrap WHERE c IS NULL
      ORDER BY context,main_version LIMIT LEAST(GREATEST(page_limit,0),100)) UNION ALL
      (SELECT context,main_version FROM access.rating_standing_bootstrap WHERE c IS NOT NULL AND context=c
      ORDER BY main_version LIMIT LEAST(GREATEST(page_limit,0),100))), removed AS (
      DELETE FROM access.rating_standing_bootstrap b USING page p WHERE (b.context,b.main_version)=(p.context,p.main_version) RETURNING 1
    ) SELECT 0*count(*) INTO n FROM removed;
  END IF;
  RETURN n;
END $$;
CREATE FUNCTION access.rating_standing_continuation_complete(c text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM access.rating_standing_progress WHERE phase<>'wait' LIMIT 1) THEN RETURN false; END IF;
  IF c IS NULL THEN RETURN NOT EXISTS(SELECT 1 FROM access.rating_standing_refresh LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM access.rating_standing_registration LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM access.rating_standing_bootstrap LIMIT 1);
  ELSE RETURN NOT EXISTS(SELECT 1 FROM access.rating_standing_refresh WHERE context=c LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM access.rating_standing_registration WHERE context=c LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM access.rating_standing_bootstrap WHERE context=c LIMIT 1); END IF;
END
$$;

-- Migration recovery is explicit, durable work too. Native components stay
-- readable; retained components remain held until historical unmerge discovery
-- has established their revocation state. No recursive bootstrap is run here.
INSERT INTO access.rating_standing_revocation SELECT DISTINCT ON(original_key) original_key,task_key
  FROM access.rating_standing_transition WHERE original_key IS NOT NULL ORDER BY original_key,task_key;
INSERT INTO access.rating_standing_progress(task_key,phase,legacy) SELECT task_key,'contexts',true
  FROM access.rating_standing_transition WHERE NOT finished OR original_key IS NOT NULL;
UPDATE access.rating_standing_transition SET prepared=true WHERE finished AND original_key IS NULL;
UPDATE access.rating_standing_lineage SET bootstrap=true
  WHERE EXISTS(SELECT 1 FROM access.rating_standing_transition WHERE original_key IS NOT NULL);
INSERT INTO access.rating_standing_bootstrap SELECT DISTINCT context,main_version FROM access.rating_standing_contribution
  WHERE merge_lineage IS NOT NULL AND EXISTS(SELECT 1 FROM access.rating_standing_transition WHERE original_key IS NOT NULL);
-- Direct pending cuts are known without ancestry discovery at upgrade time.
SELECT access.rating_standing_hold(k.context,m.main_version,t.task_key)
  FROM access.rating_standing_transition t JOIN access.rating_standing_component k
    ON (k.main_version=t.source_main_version OR t.source_main_version IS NULL AND k.work=t.source_work) AND k.slots>0
  CROSS JOIN LATERAL (VALUES(k.main_version),(t.survivor_main_version)) m(main_version)
  WHERE NOT t.finished AND m.main_version IS NOT NULL;
SELECT access.rating_standing_hold(s.context,s.main_version,t.task_key)
  FROM access.rating_standing_transition t JOIN access.rating_standing_component s ON s.work=t.survivor_work
  WHERE NOT t.finished AND t.survivor_main_version IS NULL AND EXISTS(SELECT 1 FROM access.rating_standing_component k
    WHERE k.context=s.context AND k.work=t.source_work AND k.slots>0);

CREATE OR REPLACE FUNCTION access.rating_standing_contribution_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c text := COALESCE(NEW.context,OLD.context); m text := COALESCE(NEW.main_version,OLD.main_version); d record;
BEGIN
  INSERT INTO access.rating_standing_component(context,main_version,slots,unvalued,histogram)
    VALUES(c,m,0,0,'{}') ON CONFLICT DO NOTHING;
  UPDATE access.rating_standing_component SET
    publication_revision=publication_revision+1,
    work=COALESCE(NEW.target_work,OLD.target_work,work),
    slots=slots+CASE WHEN TG_OP='INSERT' THEN 1 WHEN TG_OP='DELETE' THEN -1 ELSE 0 END,
    unvalued=unvalued+CASE WHEN TG_OP<>'DELETE' AND NOT NEW.value_known THEN 1 ELSE 0 END
      -CASE WHEN TG_OP<>'INSERT' AND NOT OLD.value_known THEN 1 ELSE 0 END,
    histogram=access.rating_standing_bin(access.rating_standing_bin(histogram,
      CASE WHEN TG_OP<>'INSERT' AND OLD.value_known THEN OLD.value END,-1),
      CASE WHEN TG_OP<>'DELETE' AND NEW.value_known THEN NEW.value END,1),
    last_admission_id=CASE WHEN TG_OP='DELETE' THEN
      (SELECT k.admission_id FROM access.rating_standing_contribution k
        WHERE k.context=c AND k.main_version=m ORDER BY k.principal_id LIMIT 1) ELSE NEW.admission_id END
    WHERE context=c AND main_version=m;
  IF TG_OP<>'INSERT' THEN
    FOR d IN SELECT 'origin' AS kind,OLD.origin_main_version AS dependency
      UNION ALL SELECT 'merge',OLD.merge_lineage WHERE OLD.merge_lineage IS NOT NULL LOOP
      UPDATE access.rating_standing_dependency SET slots=slots-1,inherited_slots=inherited_slots-CASE WHEN d.kind='origin' AND OLD.merge_lineage IS NOT NULL THEN 1 ELSE 0 END
        WHERE context=c AND main_version=m AND kind=d.kind AND dependency=d.dependency;
      DELETE FROM access.rating_standing_dependency WHERE context=c AND main_version=m
        AND kind=d.kind AND dependency=d.dependency AND slots=0;
    END LOOP;
  END IF;
  IF TG_OP<>'DELETE' THEN
    FOR d IN SELECT 'origin' AS kind,NEW.origin_main_version AS dependency
      UNION ALL SELECT 'merge',NEW.merge_lineage WHERE NEW.merge_lineage IS NOT NULL LOOP
      INSERT INTO access.rating_standing_dependency(context,main_version,kind,dependency,slots,inherited_slots)
        VALUES(c,m,d.kind,d.dependency,1,CASE WHEN d.kind='origin' AND NEW.merge_lineage IS NOT NULL THEN 1 ELSE 0 END)
        ON CONFLICT (context,main_version,kind,dependency) DO UPDATE SET slots=rating_standing_dependency.slots+1,
          inherited_slots=rating_standing_dependency.inherited_slots+EXCLUDED.inherited_slots;
      IF d.kind='origin' AND (SELECT slots=1 FROM access.rating_standing_dependency
          WHERE context=c AND main_version=m AND kind=d.kind AND dependency=d.dependency) THEN
        PERFORM access.rating_standing_register_origin(c,m,d.dependency);
      END IF;
    END LOOP;
  END IF;
  IF TG_OP<>'DELETE' AND (SELECT slots=1 FROM access.rating_standing_component WHERE context=c AND main_version=m) THEN
    PERFORM access.rating_standing_register_origin(c,m,m);
  END IF;
  RETURN NULL;
END $$;


CREATE OR REPLACE FUNCTION access.rating_standing_publication(c text,m text,OUT generation text,OUT pending bigint)
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',c,m,
      COALESCE((SELECT publication_revision::text FROM access.rating_standing_component WHERE context=c AND main_version=m),'0'),
      COALESCE((SELECT revision::text FROM access.rating_standing_cut WHERE context=c AND main_version=m),'0')),'UTF8')),'hex'),
    CASE WHEN COALESCE((SELECT pending FROM access.rating_standing_cut WHERE context=c AND main_version=m),0)>0
      OR EXISTS(SELECT 1 FROM access.rating_standing_bootstrap WHERE context=c AND main_version=m)
      OR EXISTS(SELECT 1 FROM access.rating_standing_dependency d
        CROSS JOIN LATERAL (SELECT 1 FROM access.rating_standing_refresh j
          WHERE j.context=c AND j.origin_main_version=d.dependency AND j.after_main_version<m
          ORDER BY j.after_main_version LIMIT 1) awaiting
        WHERE d.context=c AND d.main_version=m AND d.kind='origin' AND d.inherited_slots>0 LIMIT 1)
      THEN 1::bigint ELSE 0::bigint END;
$$;
-- No trigger, read, continuation or completion calls these recursive APIs.
DROP FUNCTION access.rating_standing_revoked_selections(text);
DROP FUNCTION access.rating_standing_ancestors(text,text[]);
