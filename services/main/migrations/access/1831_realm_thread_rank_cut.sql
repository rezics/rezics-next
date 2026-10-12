-- Admission and ordering share one statement snapshot. Function-local
-- enable_seqscan=off and enable_bitmapscan=off are a bounded-index contract,
-- extending the seek to dependency probes: unrelated dirty inventory must not
-- invite a scan. The caller's planner settings are restored after the function.
CREATE INDEX realm_thread_scoped_backfill ON access.feed_item(data_epoch,realm,id)
  WHERE kind IN ('reply','discussion') AND NOT realm_thread_indexed;

ALTER TABLE access.realm_thread_dirty DROP CONSTRAINT realm_thread_dirty_kind_check;
ALTER TABLE access.realm_thread_dirty ADD CHECK(kind IN ('reply','work','realm','parent','population','placement'));
-- Projection work and read invalidation are distinct: replaying an additive
-- receipt must not close an already published population. Closure uses the
-- existing realm kind, with a removal effect, before acknowledging the decision.
ALTER TABLE access.realm_thread_dirty ADD COLUMN effect text NOT NULL DEFAULT 'removal'
  CHECK(effect IN ('addition','removal'));
CREATE INDEX realm_thread_placement_effect ON access.realm_thread_dirty(data_epoch,resource COLLATE "C")
  WHERE kind='placement' AND effect='removal';

CREATE FUNCTION access.read_realm_thread_rank_cut(
  _epoch text,_realm text,_sort text,_period text,
  _rank double precision,_time bigint,_placement text,_limit integer,
  _content_epoch uuid,_content_sequence bigint,_main_sequence numeric,_population text DEFAULT NULL)
RETURNS TABLE(open boolean,complete boolean,revision text,rows jsonb)
LANGUAGE plpgsql VOLATILE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
DECLARE _order text; _dependency text; _population_ready text; _population_key text;
BEGIN
  IF _sort NOT IN ('best','top') OR _period NOT IN ('week','month','all') OR _limit<1 OR _limit>21 THEN
    RAISE EXCEPTION 'invalid Realm ranking cut' USING ERRCODE='22023';
  END IF;
  _order:=CASE WHEN _population IS NULL THEN 'realm_thread_order' ELSE 'realm_thread_private_order' END;
  _population_key:=CASE WHEN _population IS NULL THEN '' ELSE 'AND population=$11' END;
  -- The ranked root owns its child aggregates. A root outside the admitted
  -- period/history population cannot invalidate that population.
  _dependency:=format('AND EXISTS(SELECT 1 FROM access.%I o
    WHERE o.data_epoch=r.data_epoch AND o.realm=r.realm AND o.reply=r.thread
      AND o.sort=%L AND o.period=$3 %s)',_order,_sort,_population_key);
  _population_ready:=CASE WHEN _population IS NULL THEN '' ELSE
    'AND EXISTS(SELECT 1 FROM access.realm_thread_population p
      WHERE p.data_epoch=$1 AND p.realm=$2 AND p.population=$11 AND p.ready)' END;
  RETURN QUERY EXECUTE format($query$
    WITH fence AS MATERIALIZED (SELECT open FROM access.recovery_fence WHERE id FOR SHARE),
    state AS MATERIALIZED (SELECT COALESCE(s.revision,0)::text AS revision,
      c.content_epoch=$8::uuid AND c.content_sequence<=$9::bigint AND c.sequence<=$10::numeric
        AND (s.realm IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access.feed_item
          WHERE data_epoch=$1 AND realm=$2 AND kind IN ('reply','discussion')
            AND NOT realm_thread_indexed LIMIT 1))
        AND NOT EXISTS(SELECT 1 FROM access.realm_thread_dirty
          WHERE data_epoch=$1 AND kind='realm' AND resource=$2 AND effect='removal')
        AND NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='reply' AND d.resource=r.reply AND d.effect='removal'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s)
        AND NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='placement' AND d.effect='removal'
            AND d.resource COLLATE "C">=r.realm||'|'||r.reply AND d.resource COLLATE "C"<=r.realm||'|'||r.reply||'|￿'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s)
        AND NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='work' AND d.resource=r.work AND d.effect='removal'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s)
        AND NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='parent' AND d.resource=r.parent AND d.effect='removal'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s)
        AND NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.feed_item f ON f.data_epoch=r.data_epoch AND f.id=r.placement
          WHERE r.data_epoch=$1 AND r.realm=$2 AND NOT f.realm_thread_indexed %3$s)
        %4$s
        AND NOT EXISTS(SELECT 1 FROM access.%1$I WHERE data_epoch=$1 AND realm=$2 %5$s
          AND sort=%2$L AND period=$3 AND expires_at<=clock_timestamp() LIMIT 1) AS complete
      FROM (SELECT 1) root LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=$1
      LEFT JOIN access.realm_thread_state s ON s.data_epoch=$1 AND s.realm=$2)
    SELECT fence.open,state.complete,state.revision,
      COALESCE((SELECT jsonb_agg(page) FROM access.seek_realm_thread_page($1,$2,%2$L,$3,
        $4::double precision,$5::bigint,$6::text,$7::integer,$11::text) page
        WHERE state.complete AND fence.open),'[]'::jsonb) AS rows FROM fence CROSS JOIN state
    $query$,_order,_sort,_dependency,_population_ready,_population_key)
    USING _epoch,_realm,_period,_rank,_time,_placement,_limit,_content_epoch,_content_sequence,_main_sequence,_population;
END $$;

-- A command may publish its exact reference before Home receives the relay
-- activity. That later insert must retain the already settled index delta.
CREATE FUNCTION access.realm_thread_feed_arrived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('reply','discussion') THEN
    NEW.realm_thread_indexed:=EXISTS(SELECT 1 FROM access.realm_thread_reference r
      WHERE r.data_epoch=NEW.data_epoch AND r.placement=NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER realm_thread_feed_arrived BEFORE INSERT ON access.feed_item
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_feed_arrived();

-- Parent propagation belongs to this Realm's placement, whereas a Content
-- availability change still uses the existing cross-Realm reply/parent jobs.
CREATE OR REPLACE FUNCTION access.realm_thread_parent_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _epoch text; _realm text; _reply text; _effect text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.thread,OLD.active) IS NOT DISTINCT FROM (NEW.thread,NEW.active) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    _epoch:=OLD.data_epoch; _realm:=OLD.realm; _reply:=OLD.reply; _effect:='removal';
  ELSE
    _epoch:=NEW.data_epoch; _realm:=NEW.realm; _reply:=NEW.reply;
    IF TG_OP='INSERT' THEN _effect:='addition';
    ELSIF OLD.thread=NEW.thread AND NOT OLD.active AND NEW.active THEN _effect:='addition';
    ELSE _effect:='removal'; END IF;
  END IF;
  INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource,after_key,effect)
    SELECT _epoch,'placement',_realm||'|'||_reply,'children:',_effect
    WHERE EXISTS(SELECT 1 FROM access.realm_thread_reference child
      WHERE child.data_epoch=_epoch AND child.realm=_realm AND child.parent=_reply LIMIT 1)
    ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key=CASE
      WHEN access.realm_thread_dirty.after_key LIKE 'pending:%' THEN access.realm_thread_dirty.after_key
      ELSE 'children:' END,effect=CASE WHEN access.realm_thread_dirty.effect='removal'
      THEN 'removal' ELSE EXCLUDED.effect END;
  RETURN NULL;
END $$;

-- A thread bookmark can retain a readable placed branch under an inactive
-- opener. Its admission index therefore covers inactive references as well.
CREATE INDEX realm_thread_scope ON access.realm_thread_reference(data_epoch,realm,thread,reply);

CREATE FUNCTION access.read_realm_thread_scope_cut(
  _epoch text,_realm text,_focus text,_content_epoch uuid,_content_sequence bigint,
  _main_sequence numeric,_population text DEFAULT NULL)
RETURNS TABLE(ready boolean)
LANGUAGE sql VOLATILE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
  WITH fence AS MATERIALIZED (SELECT open FROM access.recovery_fence WHERE id FOR SHARE),
  focus AS MATERIALIZED (SELECT thread FROM access.realm_thread_reference
    WHERE data_epoch=_epoch AND realm=_realm AND reply=_focus),
  dependencies AS MATERIALIZED (SELECT r.reply,r.work,r.parent,r.placement
    FROM access.realm_thread_reference r WHERE r.data_epoch=_epoch AND r.realm=_realm
      AND r.thread=(SELECT thread FROM focus)
      AND (_population IS NULL OR EXISTS(SELECT 1 FROM access.realm_thread_population_admission a
        WHERE a.data_epoch=_epoch AND a.realm=_realm AND a.population=_population
          AND a.reply=r.reply AND a.admitted)))
  SELECT fence.open AND c.content_epoch=_content_epoch
    AND c.content_sequence<=_content_sequence AND c.sequence<=_main_sequence
    AND (s.realm IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access.feed_item
      WHERE data_epoch=_epoch AND realm=_realm AND kind IN ('reply','discussion')
        AND NOT realm_thread_indexed LIMIT 1))
    AND (_population IS NULL OR EXISTS(SELECT 1 FROM access.realm_thread_population p
      WHERE p.data_epoch=_epoch AND p.realm=_realm AND p.population=_population AND p.ready))
    AND NOT EXISTS(SELECT 1 FROM access.realm_thread_dirty
      WHERE data_epoch=_epoch AND kind='realm' AND resource=_realm AND effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='reply' AND d.resource=r.reply AND d.effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='placement' AND d.effect='removal' AND (
        (d.resource COLLATE "C">=_realm||'|'||r.reply AND d.resource COLLATE "C"<=_realm||'|'||r.reply||'|￿')
        OR (d.resource COLLATE "C">=_realm||'|'||r.parent AND d.resource COLLATE "C"<=_realm||'|'||r.parent||'|￿')))
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='work' AND d.resource=r.work AND d.effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='parent' AND d.resource=r.parent AND d.effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.feed_item f
      ON f.data_epoch=_epoch AND f.id=r.placement WHERE NOT f.realm_thread_indexed) AS ready
  FROM fence LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=_epoch
    LEFT JOIN access.realm_thread_state s ON s.data_epoch=_epoch AND s.realm=_realm;
$$;

-- New order is insensitive to votes, but a newly published sibling cannot
-- silently fall before an older walk's saved anchor. Removal keeps the anchor
-- useful; current placement admission continues to exclude removed material.
ALTER TABLE access.realm_thread_reference
  ADD COLUMN sibling_population_revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX realm_reply_sibling_population_revision ON access.realm_thread_reference
  (data_epoch COLLATE "C",realm COLLATE "C",reply COLLATE "C") INCLUDE(sibling_population_revision);

CREATE FUNCTION access.realm_reply_sibling_population_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent IS NULL THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.placement IS NOT DISTINCT FROM NEW.placement
      AND OLD.parent IS NOT DISTINCT FROM NEW.parent
      AND (OLD.active OR NOT NEW.active) THEN RETURN NULL; END IF;
  END IF;
  UPDATE access.realm_thread_reference SET sibling_population_revision=gen_random_uuid(),
    sibling_rank_revision=gen_random_uuid()
    WHERE data_epoch=NEW.data_epoch AND realm=NEW.realm AND reply=NEW.parent;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_reply_sibling_population_changed
  AFTER INSERT OR UPDATE OF placement,parent,active ON access.realm_thread_reference
  FOR EACH ROW EXECUTE FUNCTION access.realm_reply_sibling_population_changed();
