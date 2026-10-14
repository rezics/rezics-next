-- Extend the existing order population; the empty key is its unfiltered view.
ALTER TABLE access.realm_thread_reference
  ADD COLUMN concepts text[] CHECK(cardinality(concepts)<=8),
  ADD COLUMN new_epoch integer NOT NULL DEFAULT 0,
  ADD COLUMN new_sequence bigint NOT NULL DEFAULT 0;
-- New unclassified references are ready; only retained rows keep the NULL checkpoint.
ALTER TABLE access.realm_thread_reference ALTER COLUMN concepts SET DEFAULT '{}'::text[];
CREATE INDEX realm_thread_concept_backfill ON access.realm_thread_reference(data_epoch,realm,reply) WHERE concepts IS NULL;
ALTER TABLE access.realm_thread_order ADD COLUMN concept text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE access.realm_thread_private_order ADD COLUMN concept text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE access.realm_thread_order DROP CONSTRAINT realm_thread_order_pkey,
  DROP CONSTRAINT realm_thread_order_sort_check,
  ADD PRIMARY KEY(data_epoch,realm,sort,period,reply,concept), ADD CHECK(sort IN ('new','best','top'));
ALTER TABLE access.realm_thread_private_order DROP CONSTRAINT realm_thread_private_order_pkey,
  ADD PRIMARY KEY(data_epoch,realm,population,sort,period,reply,concept);
DROP INDEX access.realm_thread_seek;
DROP INDEX access.realm_thread_private_seek;
CREATE INDEX realm_thread_seek ON access.realm_thread_order
  (data_epoch,realm,sort,period,concept,rank_key,time_key,placement) INCLUDE(reply);
CREATE INDEX realm_thread_private_seek ON access.realm_thread_private_order
  (data_epoch,realm,population,sort,period,concept,rank_key,time_key,placement) INCLUDE(reply);

CREATE OR REPLACE FUNCTION access.refresh_realm_thread_order(_epoch text,_realm text,_reply text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r access.realm_thread_reference; _time bigint;
BEGIN
  DELETE FROM access.realm_thread_order WHERE data_epoch=_epoch AND realm=_realm AND reply=_reply;
  SELECT * INTO r FROM access.realm_thread_reference WHERE data_epoch=_epoch AND realm=_realm AND reply=_reply;
  IF NOT FOUND OR NOT r.active OR r.parent IS NOT NULL THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM access.scope_gate WHERE id='work:read:'||r.work AND NOT open)
    OR EXISTS(SELECT 1 FROM access.governance_enforcement e WHERE e.state='restricted' AND e.effect='disclosure'
      AND e.context IN ('urn:rezics:context:global',r.realm)
      AND ((e.owner='graph' AND e.resource=r.work AND e.component IN ('name','title','record','publication'))
        OR (e.owner IN ('graph','content') AND e.resource=r.reply AND e.component IN ('body','record','publication'))))
  THEN RETURN; END IF;
  _time:=round(extract(epoch FROM r.occurred_at)*1000)::bigint;
  INSERT INTO access.realm_thread_order
    SELECT _epoch,_realm,o.sort,o.period,r.reply,r.placement,o.rank,o.time,o.expiry,c.concept
    FROM (VALUES
      ('new','all',r.new_epoch::double precision,-r.new_sequence,'infinity'::timestamptz),
      ('best','all',-(sign(r.score)*log(1+abs(r.score::double precision))+_time/86400000.0),-_time,'infinity'::timestamptz),
      ('top','all',-r.score::double precision,-_time,'infinity'::timestamptz),
      ('top','week',-r.score::double precision,-_time,r.occurred_at+interval '7 days'),
      ('top','month',-r.score::double precision,-_time,r.occurred_at+interval '30 days')) o(sort,period,rank,time,expiry)
    CROSS JOIN unnest(array_prepend('',COALESCE(r.concepts,'{}'))) c(concept)
    WHERE o.expiry>clock_timestamp();
END $$;
CREATE OR REPLACE TRIGGER realm_thread_reference_changed AFTER INSERT OR UPDATE OF
  data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,score,replies,active,concepts,new_epoch,new_sequence
  ON access.realm_thread_reference FOR EACH ROW EXECUTE FUNCTION access.realm_thread_reference_changed();
CREATE OR REPLACE FUNCTION access.realm_thread_private_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    DELETE FROM access.realm_thread_private_order WHERE data_epoch=OLD.data_epoch AND realm=OLD.realm
      AND sort=OLD.sort AND period=OLD.period AND reply=OLD.reply AND concept=OLD.concept;
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO access.realm_thread_private_order
      SELECT NEW.data_epoch,NEW.realm,a.population,NEW.sort,NEW.period,NEW.reply,NEW.placement,
        NEW.rank_key,NEW.time_key,NEW.expires_at,NEW.concept FROM access.realm_thread_population_admission a
      WHERE a.data_epoch=NEW.data_epoch AND a.realm=NEW.realm AND a.reply=NEW.reply AND a.admitted
      ON CONFLICT(data_epoch,realm,population,sort,period,reply,concept) DO UPDATE SET
        placement=EXCLUDED.placement,rank_key=EXCLUDED.rank_key,time_key=EXCLUDED.time_key,expires_at=EXCLUDED.expires_at;
  END IF;
  RETURN NULL;
END $$;

DROP FUNCTION access.seek_realm_thread_page(text,text,text,text,double precision,bigint,text,integer,text);
CREATE FUNCTION access.seek_realm_thread_page(_epoch text,_realm text,_sort text,_period text,
  _rank double precision,_time bigint,_placement text,_limit integer,_population text DEFAULT NULL,_concept text DEFAULT '')
RETURNS TABLE(reply text,placement text,rank_key double precision,time_key text)
LANGUAGE plpgsql STABLE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
DECLARE _table text; _predicate text;
BEGIN
  IF _limit<1 OR _limit>21 OR _sort NOT IN ('new','best','top') OR _period NOT IN ('week','month','all') THEN
    RAISE EXCEPTION 'invalid Realm ranking seek' USING ERRCODE='22023';
  END IF;
  _table:=CASE WHEN _population IS NULL THEN 'realm_thread_order' ELSE 'realm_thread_private_order' END;
  _predicate:=CASE WHEN _rank IS NULL THEN '' ELSE
    ' AND (rank_key,time_key,placement)>($5::double precision,$6::bigint,$7::text COLLATE "C")' END;
  IF _population IS NOT NULL THEN _predicate:=_predicate||' AND population=$9'; END IF;
  RETURN QUERY EXECUTE format('SELECT reply,placement,rank_key,time_key::text FROM access.%I
    WHERE data_epoch=$1 AND realm=$2 AND sort=$3 AND period=$4 AND concept=$10 %s
    ORDER BY %I.rank_key,%I.time_key,%I.placement LIMIT $8',_table,_predicate,_table,_table,_table)
    USING _epoch,_realm,_sort,_period,_rank,_time,_placement,_limit,_population,_concept;
END $$;

-- NULL on existing references is the backfill checkpoint. The established
-- projector seeks at most 20 keys per turn and resolves current immutable
-- placements before publishing Concept keys; removals delete the same rows.
