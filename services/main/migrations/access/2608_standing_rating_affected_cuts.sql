-- Publication follows effective component dependencies, not the availability
-- of unrelated Works or the oldest transaction in the Access database.
ALTER TABLE access.rating_standing_component ADD COLUMN publication_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE access.rating_standing_component ADD COLUMN work text;
ALTER TABLE access.rating_standing_contribution ADD COLUMN merge_task_key text, ADD COLUMN merge_lineage text, ADD COLUMN target_work text;
ALTER TABLE access.rating_merge_selection ADD COLUMN standing_lineage text;
ALTER TABLE access.rating_standing_transition
  ADD COLUMN source_work text, ADD COLUMN survivor_work text,
  ADD COLUMN source_main_version text, ADD COLUMN survivor_main_version text,
  ADD COLUMN original_key text, ADD COLUMN finished boolean NOT NULL DEFAULT false;

-- Counts group provenance; a million native raters still have one dependency.
-- Each slot delta changes at most two origin/task pairs, under its existing
-- target gate. There is no counter or exclusive lock shared by unrelated Works.
CREATE TABLE access.rating_standing_dependency (
  context text NOT NULL, main_version text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('origin','merge')), dependency text NOT NULL,
  slots bigint NOT NULL CHECK (slots >= 0),
  PRIMARY KEY (context,main_version,kind,dependency)
);
CREATE TABLE access.rating_standing_lineage (
  context text NOT NULL, lineage text NOT NULL, task_key text NOT NULL, parent_lineage text,
  PRIMARY KEY (context,lineage), CHECK (lineage<>parent_lineage)
);
-- Bind a retained person snapshot to its immutable path. Path nodes group
-- equal histories across people; a component never scans every person merely
-- to determine which identity cuts can revoke its effective contributions.
CREATE TABLE access.rating_standing_lineage_member (
  context text NOT NULL, task_key text NOT NULL, principal_id uuid NOT NULL, lineage text NOT NULL,
  PRIMARY KEY (context,task_key,principal_id),
  FOREIGN KEY (context,lineage) REFERENCES access.rating_standing_lineage(context,lineage)
);
CREATE INDEX rating_standing_lineage_parent ON access.rating_standing_lineage(context,parent_lineage,lineage);
CREATE INDEX rating_standing_lineage_task ON access.rating_standing_lineage(task_key,context,lineage);
CREATE INDEX rating_standing_transition_source ON access.rating_standing_transition(source_main_version,task_key);
CREATE INDEX rating_standing_transition_survivor ON access.rating_standing_transition(survivor_main_version,task_key);
CREATE INDEX rating_standing_transition_original ON access.rating_standing_transition(original_key,task_key);
CREATE INDEX rating_standing_component_work ON access.rating_standing_component(context,work,main_version);
CREATE INDEX rating_standing_contribution_origin_member ON access.rating_standing_contribution
  (context,main_version,origin_main_version,origin_slot);
CREATE INDEX rating_merge_selection_task ON access.rating_merge_selection(task_key,context,main_version,principal_id);
CREATE INDEX rating_merge_selection_lineage ON access.rating_merge_selection(context,standing_lineage,main_version,principal_id);

INSERT INTO access.rating_standing_transition(task_key,source_work,survivor_work,original_key,finished)
  SELECT t.task_key,t.plan->'source'->>'resource',t.plan->'survivor'->>'resource',t.original_key,
    EXISTS (SELECT 1 FROM access.identity_merge_completion d WHERE d.task_key=t.task_key)
  FROM access.identity_merge_task t ON CONFLICT DO NOTHING;
UPDATE access.rating_standing_transition f SET
  source_work=t.plan->'source'->>'resource', survivor_work=t.plan->'survivor'->>'resource', original_key=t.original_key
  FROM access.identity_merge_task t WHERE t.task_key=f.task_key;
-- Main Versions are bound from the graph by the independent command fence,
-- never guessed from a retained native head that could name an older cut.
-- A pre-upgrade orphan fence may represent a graph effect whose outer journal
-- rolled back. Its affected pair cannot be guessed. Keep the old migration and
-- fence intact until recovery supplies the journal, rather than silently losing
-- its revocation or holding unrelated targets under the new contract.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM access.rating_standing_transition WHERE source_work IS NULL OR survivor_work IS NULL) THEN
    RAISE EXCEPTION 'Restore the retained identity journal before upgrading standing publication';
  END IF;
END $$;

UPDATE access.rating_standing_contribution k SET merge_task_key=s.task_key
  FROM access.rating_merge_selection s WHERE (s.context,s.main_version,s.principal_id)=(k.context,k.main_version,k.principal_id)
    AND (s.origin_main_version,s.origin_slot)=(k.origin_main_version,k.origin_slot) AND k.origin_main_version<>k.main_version;
UPDATE access.rating_standing_contribution k SET target_work=COALESCE(
  (SELECT h.work FROM access.rating_aggregate_head h WHERE h.context=k.context AND h.main_version=k.main_version
    AND h.slot=k.effective_slot),
  (SELECT s.work FROM access.rating_merge_selection s
    WHERE (s.context,s.main_version,s.principal_id)=(k.context,k.main_version,k.principal_id)));
UPDATE access.rating_standing_component c SET work=(SELECT k.target_work FROM access.rating_standing_contribution k
  WHERE k.context=c.context AND k.main_version=c.main_version ORDER BY k.principal_id LIMIT 1);
-- Preserve inherited ancestry from the authoritative retained item, including
-- old snapshots. Do not infer ancestry from a selection masked by a native vote.
-- This one-time migration resolves old retained paths. New delivery does only
-- one indexed parent lookup and at most two inserts, regardless of path depth.
WITH RECURSIVE edges AS MATERIALIZED (
  SELECT split_part(i.item_key,'|',2) AS context,i.task_key,split_part(i.item_key,'|',1)::uuid AS principal_id,
    CASE WHEN b #>> '{source,head,main_version}'=b #>> '{source,selection,origin_main_version}'
      AND b #>> '{source,head,slot}'=b #>> '{source,selection,origin_slot}'
      THEN b #>> '{source,selection,task_key}' END AS parent_task
  FROM access.identity_merge_item i CROSS JOIN LATERAL (SELECT i.before_state::jsonb AS b) snapshot
  WHERE i.owner='rating'
), paths(context,task_key,principal_id,lineage,parent_lineage) AS (
  SELECT context,task_key,principal_id,encode(sha256(convert_to(jsonb_build_array(task_key,NULL)::text,'UTF8')),'hex'),NULL::text
    FROM edges WHERE parent_task IS NULL
  UNION ALL SELECT e.context,e.task_key,e.principal_id,
    encode(sha256(convert_to(jsonb_build_array(e.task_key,p.lineage)::text,'UTF8')),'hex'),p.lineage
    FROM paths p JOIN edges e ON (e.context,e.parent_task,e.principal_id)=(p.context,p.task_key,p.principal_id)
), nodes AS (
  INSERT INTO access.rating_standing_lineage SELECT DISTINCT context,lineage,task_key,parent_lineage FROM paths
    ON CONFLICT DO NOTHING RETURNING context,lineage
) INSERT INTO access.rating_standing_lineage_member
  SELECT p.context,p.task_key,p.principal_id,p.lineage FROM paths p JOIN nodes n USING(context,lineage);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM access.identity_merge_item i WHERE i.owner='rating' AND NOT EXISTS (
    SELECT 1 FROM access.rating_standing_lineage_member m
      WHERE (m.context,m.task_key,m.principal_id)=(split_part(i.item_key,'|',2),i.task_key,split_part(i.item_key,'|',1)::uuid)))
    OR EXISTS (SELECT 1 FROM access.rating_merge_selection s WHERE NOT EXISTS (
      SELECT 1 FROM access.rating_standing_lineage_member m
        WHERE (m.context,m.task_key,m.principal_id)=(s.context,s.task_key,s.principal_id))) THEN
    RAISE EXCEPTION 'Standing rating ancestry requires its complete retained identity snapshots';
  END IF;
END $$;
UPDATE access.rating_merge_selection s SET standing_lineage=m.lineage FROM access.rating_standing_lineage_member m
  WHERE (m.context,m.task_key,m.principal_id)=(s.context,s.task_key,s.principal_id);
ALTER TABLE access.rating_merge_selection ALTER COLUMN standing_lineage SET NOT NULL;
UPDATE access.rating_standing_contribution k SET merge_lineage=s.standing_lineage FROM access.rating_merge_selection s
  WHERE (k.context,k.main_version,k.principal_id)=(s.context,s.main_version,s.principal_id) AND k.merge_task_key=s.task_key;
INSERT INTO access.rating_standing_dependency
  SELECT context,main_version,'origin',origin_main_version,count(*) FROM access.rating_standing_contribution
    GROUP BY context,main_version,origin_main_version
  UNION ALL SELECT context,main_version,'merge',merge_lineage,count(*) FROM access.rating_standing_contribution
    WHERE merge_lineage IS NOT NULL GROUP BY context,main_version,merge_lineage;

CREATE FUNCTION access.rating_standing_selection_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; parent_task text; parent text; path text; recorded text;
BEGIN
  SELECT before_state::jsonb INTO b FROM access.identity_merge_item
    WHERE task_key=NEW.task_key AND owner='rating' AND item_key=NEW.principal_id::text||'|'||NEW.context;
  IF b #>> '{source,head,main_version}'=b #>> '{source,selection,origin_main_version}'
    AND b #>> '{source,head,slot}'=b #>> '{source,selection,origin_slot}' THEN
    parent_task := b #>> '{source,selection,task_key}';
    SELECT lineage INTO parent FROM access.rating_standing_lineage_member
      WHERE context=NEW.context AND task_key=parent_task AND principal_id=NEW.principal_id;
    IF parent_task IS NOT NULL AND parent IS NULL THEN RAISE EXCEPTION 'Standing rating parent lineage is unavailable'; END IF;
  END IF;
  path := encode(sha256(convert_to(jsonb_build_array(NEW.task_key,parent)::text,'UTF8')),'hex');
  INSERT INTO access.rating_standing_lineage VALUES(NEW.context,path,NEW.task_key,parent) ON CONFLICT DO NOTHING;
  INSERT INTO access.rating_standing_lineage_member VALUES(NEW.context,NEW.task_key,NEW.principal_id,path) ON CONFLICT DO NOTHING;
  SELECT lineage INTO recorded FROM access.rating_standing_lineage_member
    WHERE context=NEW.context AND task_key=NEW.task_key AND principal_id=NEW.principal_id;
  IF recorded<>path THEN RAISE EXCEPTION 'Standing rating retained lineage changed'; END IF;
  NEW.standing_lineage := path;
  RETURN NEW;
END $$;
CREATE TRIGGER rating_standing_selection_lineage BEFORE INSERT OR UPDATE ON access.rating_merge_selection
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_selection_lineage();

CREATE FUNCTION access.rating_standing_ancestors(c text,roots text[]) RETURNS TABLE(task_key text,lineage text,parent_lineage text)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestors AS (
    SELECT l.task_key,l.lineage,l.parent_lineage FROM access.rating_standing_lineage l WHERE l.context=c AND l.lineage=ANY(roots)
    UNION SELECT l.task_key,l.lineage,l.parent_lineage FROM ancestors a
      JOIN access.rating_standing_lineage l ON l.context=c AND l.lineage=a.parent_lineage
  ) SELECT * FROM ancestors;
$$;
CREATE FUNCTION access.rating_standing_merge_revoked(c text,path text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM access.rating_standing_ancestors(c,ARRAY[path]) a
    JOIN access.rating_standing_transition t ON t.original_key=a.task_key WHERE t.finished LIMIT 1);
$$;

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
      UPDATE access.rating_standing_dependency SET slots=slots-1
        WHERE context=c AND main_version=m AND kind=d.kind AND dependency=d.dependency;
      DELETE FROM access.rating_standing_dependency WHERE context=c AND main_version=m
        AND kind=d.kind AND dependency=d.dependency AND slots=0;
    END LOOP;
  END IF;
  IF TG_OP<>'DELETE' THEN
    FOR d IN SELECT 'origin' AS kind,NEW.origin_main_version AS dependency
      UNION ALL SELECT 'merge',NEW.merge_lineage WHERE NEW.merge_lineage IS NOT NULL LOOP
      INSERT INTO access.rating_standing_dependency VALUES(c,m,d.kind,d.dependency,1)
        ON CONFLICT (context,main_version,kind,dependency) DO UPDATE SET slots=rating_standing_dependency.slots+1;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.refresh_rating_standing_slot(c text,m text,person uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE; s access.rating_merge_selection%ROWTYPE; present boolean; task text;
BEGIN
  INSERT INTO access.rating_observation_gate(context,target) VALUES(c,m) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM access.rating_observation_gate WHERE context=c AND target=m FOR UPDATE;
  SELECT * INTO h FROM access.rating_aggregate_head WHERE context=c AND main_version=m
    AND slot=access.rating_standing_slot(person,c,m) AND target_release IS NULL FOR SHARE;
  present := FOUND;
  IF NOT present THEN
    SELECT * INTO s FROM access.rating_merge_selection WHERE context=c AND main_version=m AND principal_id=person;
    present := FOUND;
    IF present THEN
      task := s.task_key;
      -- Revocation is checked on every continuation as well as every read.
      -- The bounded cleanup removes this selection; never reconstruct its vote.
      IF access.rating_standing_merge_revoked(c,s.standing_lineage) THEN present := false;
      ELSE SELECT * INTO h FROM access.rating_aggregate_head WHERE context=c AND main_version=s.origin_main_version
        AND slot=s.origin_slot AND principal_id=person AND target_release IS NULL FOR SHARE; END IF;
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
    ON CONFLICT (context,main_version,principal_id) DO UPDATE SET
      origin_main_version=EXCLUDED.origin_main_version,origin_slot=EXCLUDED.origin_slot,
      value=EXCLUDED.value,value_known=EXCLUDED.value_known,admission_id=EXCLUDED.admission_id,merge_task_key=EXCLUDED.merge_task_key,merge_lineage=EXCLUDED.merge_lineage,
      target_work=EXCLUDED.target_work
    WHERE (rating_standing_contribution.origin_main_version,rating_standing_contribution.origin_slot,
      rating_standing_contribution.value,rating_standing_contribution.value_known,rating_standing_contribution.admission_id,
      rating_standing_contribution.merge_task_key,rating_standing_contribution.merge_lineage,rating_standing_contribution.target_work) IS DISTINCT FROM
      (EXCLUDED.origin_main_version,EXCLUDED.origin_slot,EXCLUDED.value,EXCLUDED.value_known,EXCLUDED.admission_id,EXCLUDED.merge_task_key,EXCLUDED.merge_lineage,EXCLUDED.target_work);
END $$;

DROP TRIGGER rating_standing_transition_pending ON access.rating_standing_transition;
DROP TRIGGER rating_standing_refresh_pending ON access.rating_standing_refresh;
CREATE OR REPLACE FUNCTION access.rating_standing_transition_finished() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.rating_standing_transition SET finished=true WHERE task_key=NEW.task_key;
  RETURN NULL;
END $$;

-- Hash the relevant retained identity cuts, not the maximum transaction id.
-- A late lower-xid commit changes this set too. No unrelated transaction can
-- hold publication, and finish/revoke/retry between two reads cannot disappear.
CREATE FUNCTION access.rating_standing_publication(c text,m text,OUT generation text,OUT pending bigint)
LANGUAGE sql STABLE AS $$
  WITH dependencies AS MATERIALIZED (
    SELECT kind,dependency FROM access.rating_standing_dependency WHERE context=c AND main_version=m
  ), ancestors AS MATERIALIZED (
    SELECT task_key FROM access.rating_standing_ancestors(c,ARRAY(SELECT dependency FROM dependencies WHERE kind='merge'))
  ), related AS MATERIALIZED (
    SELECT t.task_key,t.finished,t.original_key FROM access.rating_standing_transition t
    WHERE (t.source_main_version=m OR t.survivor_main_version=m) AND EXISTS (
        SELECT 1 FROM access.rating_standing_component k WHERE k.context=c AND k.main_version=t.source_main_version AND k.slots>0)
      OR t.source_main_version IN (SELECT dependency FROM dependencies WHERE kind='origin')
      OR t.source_main_version IS NULL AND t.source_work IN (SELECT k.work FROM access.rating_standing_component k WHERE k.context=c
        AND k.slots>0 AND (k.main_version=m OR k.main_version IN (SELECT dependency FROM dependencies WHERE kind='origin')))
      OR t.survivor_main_version IS NULL AND t.survivor_work=(SELECT work FROM access.rating_standing_component WHERE context=c AND main_version=m)
        AND EXISTS (SELECT 1 FROM access.rating_standing_component k WHERE k.context=c AND k.work=t.source_work AND k.slots>0)
      OR t.task_key IN (SELECT task_key FROM ancestors) OR t.original_key IN (SELECT task_key FROM ancestors)
  )
  SELECT encode(sha256(convert_to(concat_ws('|',c,m,
    COALESCE((SELECT publication_revision::text FROM access.rating_standing_component WHERE context=c AND main_version=m),'0'),
    (SELECT jsonb_agg(jsonb_build_array(task_key,finished,original_key) ORDER BY task_key)::text FROM related)),'UTF8')),'hex'),
    CASE WHEN EXISTS (SELECT 1 FROM related WHERE NOT finished OR original_key IN (SELECT task_key FROM ancestors) LIMIT 1)
      OR EXISTS (SELECT 1 FROM access.rating_standing_refresh j
        JOIN access.rating_standing_contribution k ON k.context=c AND k.main_version=m
          AND (k.context,k.origin_main_version,k.origin_slot)=(j.context,j.origin_main_version,j.origin_slot)
        LEFT JOIN access.rating_aggregate_head h ON (h.context,h.main_version,h.slot)=(j.context,j.origin_main_version,j.origin_slot)
        WHERE j.context=c AND (k.admission_id IS DISTINCT FROM h.admission_id
          OR k.value_known IS DISTINCT FROM COALESCE(h.value_known,false) OR k.value IS DISTINCT FROM h.value) LIMIT 1)
      THEN 1::bigint ELSE 0::bigint END;
$$;

-- Revoked inherited snapshots can outlive the pair's native unmerge page.
-- Find them through retained task ancestry, then delete at most one owner page.
CREATE FUNCTION access.rating_standing_revoked_selections(c text)
RETURNS TABLE(context text,main_version text,principal_id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE revoked(context,lineage) AS (
    SELECT l.context,l.lineage FROM access.rating_standing_transition t
      JOIN access.rating_standing_lineage l ON l.task_key=t.original_key
      WHERE t.finished AND (c IS NULL OR l.context=c)
    UNION SELECT l.context,l.lineage FROM revoked r
      JOIN access.rating_standing_lineage l ON l.context=r.context AND l.parent_lineage=r.lineage
  ) SELECT s.context,s.main_version,s.principal_id FROM revoked r
    JOIN access.rating_merge_selection s ON s.context=r.context AND s.standing_lineage=r.lineage;
$$;
CREATE FUNCTION access.cleanup_rating_standing_projections(c text,page_limit integer) RETURNS integer LANGUAGE sql AS $$
  WITH page AS MATERIALIZED (
    SELECT s.context,s.main_version,s.principal_id FROM access.rating_standing_revoked_selections(c) r
      JOIN access.rating_merge_selection s USING(context,main_version,principal_id)
      ORDER BY s.context,s.main_version,s.principal_id LIMIT LEAST(GREATEST(page_limit,0),100) FOR UPDATE OF s SKIP LOCKED
  ), authority AS MATERIALIZED (
    SELECT g.id FROM access.scope_gate g WHERE g.id IN (SELECT 'rating:observe:'||context FROM page)
      ORDER BY g.id FOR SHARE
  ), removed AS (
    DELETE FROM access.rating_merge_selection s USING page p
      WHERE (s.context,s.main_version,s.principal_id)=(p.context,p.main_version,p.principal_id)
        AND (SELECT count(*) FROM authority)>=0 RETURNING 1
  ) SELECT count(*)::integer FROM removed;
$$;
