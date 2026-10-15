-- Freeze expiry at the statement cut and read the first expiry key. A
-- selected timestamp retains its ordering; EXISTS can discard ORDER BY and
-- filter every live row through an unrelated index when estimates are small.
CREATE INDEX realm_thread_private_period_expiry ON access.realm_thread_private_order(data_epoch,realm,population,sort,period,expires_at);
CREATE INDEX realm_thread_removal_kind ON access.realm_thread_dirty(data_epoch,kind) WHERE effect='removal';

CREATE FUNCTION access.discovery_realm_thread_expiry(_epoch text,_realm text,_sort text,_period text,_population text)
RETURNS timestamptz LANGUAGE plpgsql STABLE
SET enable_seqscan=off SET enable_bitmapscan=off SET enable_sort=off SET jit=off AS $$
DECLARE expiry timestamptz;
BEGIN
  IF _population IS NULL THEN
    SELECT expires_at INTO expiry FROM access.realm_thread_order
      WHERE data_epoch=_epoch AND realm=_realm AND sort=_sort AND period=_period
      ORDER BY expires_at LIMIT 1;
  ELSE
    SELECT expires_at INTO expiry FROM access.realm_thread_private_order
      WHERE data_epoch=_epoch AND realm=_realm AND population=_population AND sort=_sort AND period=_period
      ORDER BY expires_at LIMIT 1;
  END IF;
  RETURN expiry;
END $$;

CREATE OR REPLACE FUNCTION access.read_realm_thread_rank_cut(
  _epoch text,_realm text,_sort text,_period text,
  _rank double precision,_time bigint,_placement text,_limit integer,
  _content_epoch uuid,_content_sequence bigint,_main_sequence numeric,_population text DEFAULT NULL)
RETURNS TABLE(open boolean,complete boolean,revision text,rows jsonb)
LANGUAGE plpgsql VOLATILE SET enable_bitmapscan=off SET enable_seqscan=off SET enable_sort=off AS $$
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
        AND CASE WHEN EXISTS(SELECT 1 FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='reply' AND effect='removal' LIMIT 1) THEN NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='reply' AND d.resource=r.reply AND d.effect='removal'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s) ELSE true END
        AND CASE WHEN EXISTS(SELECT 1 FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='placement' AND effect='removal' LIMIT 1) THEN NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='placement' AND d.effect='removal'
            AND d.resource COLLATE "C">=r.realm||'|'||r.reply AND d.resource COLLATE "C"<=r.realm||'|'||r.reply||'|￿'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s) ELSE true END
        AND CASE WHEN EXISTS(SELECT 1 FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='work' AND effect='removal' LIMIT 1) THEN NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='work' AND d.resource=r.work AND d.effect='removal'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s) ELSE true END
        AND CASE WHEN EXISTS(SELECT 1 FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='parent' AND effect='removal' LIMIT 1) THEN NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.realm_thread_dirty d ON d.data_epoch=r.data_epoch AND d.kind='parent' AND d.resource=r.parent AND d.effect='removal'
          WHERE r.data_epoch=$1 AND r.realm=$2 %3$s) ELSE true END
        AND CASE WHEN EXISTS(SELECT 1 FROM access.feed_item WHERE data_epoch=$1 AND realm=$2
          AND kind IN ('reply','discussion') AND NOT realm_thread_indexed LIMIT 1) THEN
        NOT EXISTS(SELECT 1 FROM access.realm_thread_reference r
          JOIN access.feed_item f ON f.data_epoch=r.data_epoch AND f.id=r.placement
          WHERE r.data_epoch=$1 AND r.realm=$2 AND f.kind IN ('reply','discussion') AND NOT f.realm_thread_indexed %3$s)
        ELSE true END
        %4$s
        AND COALESCE(access.discovery_realm_thread_expiry($1,$2,%2$L,$3,$11)>statement_timestamp(),true) AS complete
      FROM (SELECT 1) root LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=$1
      LEFT JOIN access.realm_thread_state s ON s.data_epoch=$1 AND s.realm=$2)
    SELECT fence.open,state.complete,state.revision,
      COALESCE((SELECT jsonb_agg(page) FROM access.seek_realm_thread_page($1,$2,%2$L,$3,
        $4::double precision,$5::bigint,$6::text,$7::integer,$11::text) page
        WHERE state.complete AND fence.open),'[]'::jsonb) AS rows FROM fence CROSS JOIN state
    $query$,_order,_sort,_dependency,_population_ready,_population_key)
    USING _epoch,_realm,_period,_rank,_time,_placement,_limit,_content_epoch,_content_sequence,_main_sequence,_population;
END $$;


-- Small inventories must use the same ordered range as large inventories.
CREATE OR REPLACE FUNCTION access.seek_realm_thread_page(_epoch text,_realm text,_sort text,_period text,
  _rank double precision,_time bigint,_placement text,_limit integer,_population text DEFAULT NULL,_concept text DEFAULT '')
RETURNS TABLE(reply text,placement text,rank_key double precision,time_key text)
LANGUAGE plpgsql STABLE SET enable_bitmapscan=off SET enable_seqscan=off SET enable_sort=off AS $$
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

-- A selected placement checks its own pending flag; a hash anti-join can
-- otherwise scan every feed row merely to prove that this flag is absent.
CREATE FUNCTION access.discovery_feed_thread_pending(epoch text, placement text)
RETURNS boolean LANGUAGE sql STABLE
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT COALESCE((SELECT NOT realm_thread_indexed FROM access.feed_item
    WHERE data_epoch=epoch AND id=placement LIMIT 1),false);
$$;

CREATE OR REPLACE FUNCTION access.read_realm_thread_scope_cut(
  _epoch text,_realm text,_replies text[],_content_epoch uuid,_content_sequence bigint,
  _main_sequence numeric,_population text DEFAULT NULL)
RETURNS TABLE(ready boolean)
LANGUAGE sql VOLATILE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
  WITH fence AS MATERIALIZED (SELECT open FROM access.recovery_fence WHERE id FOR SHARE),
  dependencies AS MATERIALIZED (SELECT r.reply,r.work,r.parent,r.placement
    FROM unnest(_replies) AS selected(reply)
    CROSS JOIN LATERAL (SELECT reply,work,parent,placement FROM access.realm_thread_reference
      WHERE data_epoch=_epoch AND realm=_realm AND reply=selected.reply LIMIT 1) r
    WHERE (_population IS NULL OR EXISTS(SELECT 1 FROM access.realm_thread_population_admission a
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
    AND NOT EXISTS(SELECT 1 FROM dependencies r WHERE access.discovery_feed_thread_pending(_epoch,r.placement)) AS ready
  FROM fence LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=_epoch
    LEFT JOIN access.realm_thread_state s ON s.data_epoch=_epoch AND s.realm=_realm;
$$;
