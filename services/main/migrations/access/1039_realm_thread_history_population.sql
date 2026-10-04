-- History from admission is a different admitted population, not a predicate
-- applied after score LIMIT. Equal immutable admission cuts share one index.
CREATE TABLE access.realm_thread_population (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  population text NOT NULL,
  floor_epoch text NOT NULL,
  floor_sequence numeric NOT NULL,
  after_reply text NOT NULL DEFAULT '',
  ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY(data_epoch,realm,population)
);
CREATE INDEX realm_thread_population_build ON access.realm_thread_population(data_epoch,realm,population) WHERE NOT ready;
CREATE TABLE access.realm_thread_population_admission (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  population text NOT NULL,
  reply text NOT NULL,
  admitted boolean NOT NULL,
  PRIMARY KEY(data_epoch,realm,population,reply),
  FOREIGN KEY(data_epoch,realm,population) REFERENCES access.realm_thread_population ON DELETE CASCADE,
  FOREIGN KEY(data_epoch,realm,reply) REFERENCES access.realm_thread_reference ON DELETE CASCADE
);
CREATE INDEX realm_thread_population_reply ON access.realm_thread_population_admission(data_epoch,realm,reply,population);
CREATE TABLE access.realm_thread_population_job (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  population text NOT NULL,
  reply text NOT NULL,
  PRIMARY KEY(data_epoch,realm,population,reply),
  FOREIGN KEY(data_epoch,realm,population) REFERENCES access.realm_thread_population ON DELETE CASCADE
);
CREATE TABLE access.realm_thread_private_order (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  population text NOT NULL,
  sort text NOT NULL,
  period text NOT NULL,
  reply text NOT NULL,
  placement text COLLATE "C" NOT NULL,
  rank_key double precision NOT NULL,
  time_key bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(data_epoch,realm,population,sort,period,reply),
  FOREIGN KEY(data_epoch,realm,population,reply) REFERENCES access.realm_thread_population_admission ON DELETE CASCADE
);
CREATE INDEX realm_thread_private_seek ON access.realm_thread_private_order
  (data_epoch,realm,population,sort,period,rank_key,time_key,placement) INCLUDE(reply);

CREATE FUNCTION access.realm_thread_population_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Admission depends on a slot's immutable FIRST publication, so ordinary
  -- edits/votes need no new history probe. New slots queue their exact keys.
  INSERT INTO access.realm_thread_population_job
    SELECT NEW.data_epoch,NEW.realm,population,NEW.reply FROM access.realm_thread_population
      WHERE data_epoch=NEW.data_epoch AND realm=NEW.realm ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_population_source_changed AFTER INSERT ON access.realm_thread_reference
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_population_source_changed();
CREATE FUNCTION access.realm_thread_private_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    DELETE FROM access.realm_thread_private_order WHERE data_epoch=OLD.data_epoch AND realm=OLD.realm
      AND sort=OLD.sort AND period=OLD.period AND reply=OLD.reply;
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO access.realm_thread_private_order
      SELECT NEW.data_epoch,NEW.realm,a.population,NEW.sort,NEW.period,NEW.reply,NEW.placement,
        NEW.rank_key,NEW.time_key,NEW.expires_at FROM access.realm_thread_population_admission a
      WHERE a.data_epoch=NEW.data_epoch AND a.realm=NEW.realm AND a.reply=NEW.reply AND a.admitted
      ON CONFLICT(data_epoch,realm,population,sort,period,reply) DO UPDATE SET
        placement=EXCLUDED.placement,rank_key=EXCLUDED.rank_key,time_key=EXCLUDED.time_key,expires_at=EXCLUDED.expires_at;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_private_order_changed AFTER INSERT OR UPDATE OR DELETE ON access.realm_thread_order
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_private_order_changed();

-- A small-tail cardinality estimate otherwise chose a bitmap scan + sort in
-- the 100-thread diagnostic. Keep this operation's planner settings local to
-- its indexed seek; no session/global tuning or hydration policy is changed.
CREATE FUNCTION access.seek_realm_thread_page(_epoch text,_realm text,_sort text,_period text,
  _rank double precision,_time bigint,_placement text,_limit integer,_population text DEFAULT NULL)
RETURNS TABLE(reply text,placement text,rank_key double precision,time_key text)
LANGUAGE plpgsql STABLE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
DECLARE _table text; _predicate text;
BEGIN
  IF _limit<1 OR _limit>21 OR _sort NOT IN ('best','top') OR _period NOT IN ('week','month','all') THEN
    RAISE EXCEPTION 'invalid Realm ranking seek' USING ERRCODE='22023';
  END IF;
  _table:=CASE WHEN _population IS NULL THEN 'realm_thread_order' ELSE 'realm_thread_private_order' END;
  _predicate:=CASE WHEN _rank IS NULL THEN '' ELSE
    ' AND (rank_key,time_key,placement)>($5::double precision,$6::bigint,$7::text COLLATE "C")' END;
  IF _population IS NOT NULL THEN _predicate:=_predicate||' AND population=$9'; END IF;
  RETURN QUERY EXECUTE format('SELECT reply,placement,rank_key,time_key::text FROM access.%I
    WHERE data_epoch=$1 AND realm=$2 AND sort=$3 AND period=$4 %s
    ORDER BY %I.rank_key,%I.time_key,%I.placement LIMIT $8',_table,_predicate,_table,_table,_table)
    USING _epoch,_realm,_sort,_period,_rank,_time,_placement,_limit,_population;
END $$;
