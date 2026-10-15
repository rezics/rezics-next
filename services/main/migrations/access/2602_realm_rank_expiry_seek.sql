-- Freeze expiry at the statement cut so the B-tree can seek the expired range.
-- A volatile clock predicate filters every live rank before proving absence.
CREATE INDEX realm_thread_removal_kind ON access.realm_thread_dirty(data_epoch,kind) WHERE effect='removal';

CREATE OR REPLACE FUNCTION access.read_realm_thread_rank_cut(
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
        AND NOT EXISTS(SELECT 1 FROM access.%1$I WHERE data_epoch=$1 AND realm=$2 %5$s
          AND sort=%2$L AND period=$3 AND expires_at<=statement_timestamp() LIMIT 1) AS complete
      FROM (SELECT 1) root LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=$1
      LEFT JOIN access.realm_thread_state s ON s.data_epoch=$1 AND s.realm=$2)
    SELECT fence.open,state.complete,state.revision,
      COALESCE((SELECT jsonb_agg(page) FROM access.seek_realm_thread_page($1,$2,%2$L,$3,
        $4::double precision,$5::bigint,$6::text,$7::integer,$11::text) page
        WHERE state.complete AND fence.open),'[]'::jsonb) AS rows FROM fence CROSS JOIN state
    $query$,_order,_sort,_dependency,_population_ready,_population_key)
    USING _epoch,_realm,_period,_rank,_time,_placement,_limit,_content_epoch,_content_sequence,_main_sequence,_population;
END $$;
