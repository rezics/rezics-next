-- A witness attests a published component, never an in-progress identity or
-- projection transition. Writers append independent change rows: unrelated
-- targets never update a common counter or take an exclusive publication lock.
CREATE TABLE access.rating_standing_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch bigint NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX rating_standing_change_order ON access.rating_standing_change(epoch,xid,id);

-- No task FK: this fence must COMMIT on an independent checkout before the
-- graph effect, including when the journal is inside a borrowed transaction.
-- A failed/uncertain delivery retains the fence until that task is reconciled.
CREATE TABLE access.rating_standing_transition (task_key text PRIMARY KEY);
CREATE TABLE access.rating_standing_refresh (
  context text NOT NULL REFERENCES access.rating_aggregate_context(context),
  origin_main_version text NOT NULL,
  origin_slot text NOT NULL,
  after_main_version text NOT NULL,
  after_principal_id uuid NOT NULL,
  PRIMARY KEY (context,origin_main_version,origin_slot)
);

CREATE FUNCTION access.rating_standing_pending_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.rating_standing_changed',true)='on' THEN RETURN NULL; END IF;
  INSERT INTO access.rating_standing_change(epoch)
    SELECT generation FROM access.recovery_fence WHERE id FOR SHARE;
  PERFORM set_config('rezics.rating_standing_changed','on',true);
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_transition_pending AFTER INSERT OR DELETE ON access.rating_standing_transition
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_pending_changed();
CREATE TRIGGER rating_standing_refresh_pending AFTER INSERT OR DELETE ON access.rating_standing_refresh
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_pending_changed();

INSERT INTO access.rating_standing_transition(task_key)
  SELECT t.task_key FROM access.identity_merge_task t
  WHERE NOT EXISTS (SELECT 1 FROM access.identity_merge_completion c WHERE c.task_key=t.task_key);
CREATE FUNCTION access.rating_standing_transition_finished() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access.rating_standing_transition WHERE task_key=NEW.task_key;
  RETURN NULL;
END $$;
CREATE TRIGGER rating_standing_transition_finished AFTER INSERT ON access.identity_merge_completion
  FOR EACH ROW EXECUTE FUNCTION access.rating_standing_transition_finished();

-- Two indexed change probes and two pending probes, independent of population
-- and history. A visible change at/above xmin conservatively holds publication
-- until older transactions drain. Thus a late lower-xid commit cannot hide
-- behind a newer settled key. Recovery generation leads xid across restores.
CREATE FUNCTION access.rating_standing_publication(OUT generation text, OUT pending bigint)
LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.rating_standing_change c
      WHERE (c.epoch,c.xid)<(h.generation,h.xmin)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1)),'UTF8')),'hex'),
    CASE WHEN EXISTS (SELECT 1 FROM access.rating_standing_change c
        WHERE (c.epoch,c.xid)>=(h.generation,h.xmin) LIMIT 1)
      OR EXISTS (SELECT 1 FROM access.rating_standing_transition LIMIT 1)
      OR EXISTS (SELECT 1 FROM access.rating_standing_refresh LIMIT 1)
      THEN 1::bigint ELSE 0::bigint END
  FROM horizon h;
$$;

-- Maintenance reclaims at most 256 settled rows, retaining the equality head.
-- Only the bounded projection worker invokes this; request reads never prune.
CREATE FUNCTION access.prune_rating_standing_changes() RETURNS integer LANGUAGE sql
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id AND open
  ), keeper AS MATERIALIZED (
    SELECT c.epoch,c.xid,c.id FROM access.rating_standing_change c
      WHERE (c.epoch,c.xid)<(SELECT generation,xmin FROM horizon)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1
  ), removed AS (
    DELETE FROM access.rating_standing_change WHERE ctid = ANY(ARRAY(
      SELECT c.ctid FROM access.rating_standing_change c
      WHERE (c.epoch,c.xid,c.id)<(SELECT epoch,xid,id FROM keeper)
      ORDER BY c.epoch,c.xid,c.id LIMIT 256 FOR UPDATE OF c SKIP LOCKED
    )) RETURNING id
  )
  SELECT count(*)::integer FROM removed;
$$;

-- Origin replacement/deletion can have arbitrarily many retained projections.
-- This ordering supports an exact first probe and resumable keyset pages.
CREATE INDEX rating_merge_selection_origin_page ON access.rating_merge_selection
  (context,origin_main_version,origin_slot,main_version,principal_id);
DROP INDEX access.rating_merge_selection_origin;

CREATE OR REPLACE FUNCTION access.rating_standing_head_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h access.rating_aggregate_head%ROWTYPE := COALESCE(NEW,OLD); first_target access.rating_merge_selection%ROWTYPE; more boolean;
BEGIN
  IF h.target_release IS NOT NULL OR h.slot<>access.rating_standing_slot(h.principal_id,h.context,h.main_version) THEN RETURN NULL; END IF;
  PERFORM access.refresh_rating_standing_slot(h.context,h.main_version,h.principal_id);
  -- One synchronous retained projection keeps the usual two-Work merge current.
  -- At most two slot refreshes per changed head, including reconstruction CAS.
  SELECT s.* INTO first_target FROM access.rating_merge_selection s
    WHERE s.context=h.context AND s.origin_main_version=h.main_version AND s.origin_slot=h.slot
    ORDER BY s.main_version,s.principal_id LIMIT 1;
  IF FOUND THEN
    PERFORM access.refresh_rating_standing_slot(h.context,first_target.main_version,first_target.principal_id);
    SELECT EXISTS (SELECT 1 FROM access.rating_merge_selection s
      WHERE s.context=h.context AND s.origin_main_version=h.main_version AND s.origin_slot=h.slot
        AND (s.main_version,s.principal_id)>(first_target.main_version,first_target.principal_id)
      ORDER BY s.main_version,s.principal_id LIMIT 1) INTO more;
  END IF;
  IF COALESCE(more,false) THEN
    INSERT INTO access.rating_standing_refresh(context,origin_main_version,origin_slot,after_main_version,after_principal_id)
      VALUES(h.context,h.main_version,h.slot,first_target.main_version,first_target.principal_id)
      ON CONFLICT (context,origin_main_version,origin_slot) DO UPDATE SET
        after_main_version=EXCLUDED.after_main_version,after_principal_id=EXCLUDED.after_principal_id;
  ELSE
    DELETE FROM access.rating_standing_refresh
      WHERE context=h.context AND origin_main_version=h.main_version AND origin_slot=h.slot;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.rating_standing_selection_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.context,OLD.main_version,OLD.principal_id)
    IS DISTINCT FROM (NEW.context,NEW.main_version,NEW.principal_id) THEN
    PERFORM access.refresh_rating_standing_slot(OLD.context,OLD.main_version,OLD.principal_id);
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM access.refresh_rating_standing_slot(OLD.context,OLD.main_version,OLD.principal_id);
  ELSE
    PERFORM access.refresh_rating_standing_slot(NEW.context,NEW.main_version,NEW.principal_id);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.rating_standing_contribution_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c text := COALESCE(NEW.context,OLD.context); m text := COALESCE(NEW.main_version,OLD.main_version);
BEGIN
  INSERT INTO access.rating_standing_component(context,main_version,slots,unvalued,histogram)
    VALUES (c,m,0,0,'{}') ON CONFLICT DO NOTHING;
  UPDATE access.rating_standing_component SET
    slots = slots + CASE WHEN TG_OP='INSERT' THEN 1 WHEN TG_OP='DELETE' THEN -1 ELSE 0 END,
    unvalued = unvalued + CASE WHEN TG_OP<>'DELETE' AND NOT NEW.value_known THEN 1 ELSE 0 END
      - CASE WHEN TG_OP<>'INSERT' AND NOT OLD.value_known THEN 1 ELSE 0 END,
    histogram = access.rating_standing_bin(access.rating_standing_bin(histogram,
      CASE WHEN TG_OP<>'INSERT' AND OLD.value_known THEN OLD.value END,-1),
      CASE WHEN TG_OP<>'DELETE' AND NEW.value_known THEN NEW.value END,1),
    -- An exact indexed surviving slot, not the admission of the deleted head.
    -- Unknown/missing origins still leave the component explicitly unvalued.
    last_admission_id = CASE WHEN TG_OP='DELETE' THEN
      (SELECT k.admission_id FROM access.rating_standing_contribution k
       WHERE k.context=c AND k.main_version=m ORDER BY k.principal_id LIMIT 1)
      ELSE NEW.admission_id END
    WHERE context=c AND main_version=m;
  RETURN NULL;
END $$;

-- Heal an already deleted witness at upgrade without reconstructing scores.
UPDATE access.rating_standing_component c SET last_admission_id=(
  SELECT k.admission_id FROM access.rating_standing_contribution k
  WHERE k.context=c.context AND k.main_version=c.main_version ORDER BY k.principal_id LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM access.rating_aggregate_head h WHERE h.admission_id=c.last_admission_id);
