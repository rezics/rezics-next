-- Replays and score changes preserve the ranked population's revision, including
-- Concept views. Delete only keys that left the population and update changed keys.
CREATE OR REPLACE FUNCTION access.refresh_realm_thread_order(_epoch text,_realm text,_reply text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r access.realm_thread_reference; _time bigint; _now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO r FROM access.realm_thread_reference WHERE data_epoch=_epoch AND realm=_realm AND reply=_reply;
  IF NOT FOUND OR NOT r.active OR r.parent IS NOT NULL
    OR EXISTS(SELECT 1 FROM access.scope_gate WHERE id='work:read:'||r.work AND NOT open)
    OR EXISTS(SELECT 1 FROM access.governance_enforcement e WHERE e.state='restricted' AND e.effect='disclosure'
      AND e.context IN ('urn:rezics:context:global',r.realm)
      AND ((e.owner='graph' AND e.resource=r.work AND e.component IN ('name','title','record','publication'))
        OR (e.owner IN ('graph','content') AND e.resource=r.reply AND e.component IN ('body','record','publication'))))
  THEN
    DELETE FROM access.realm_thread_order WHERE data_epoch=_epoch AND realm=_realm AND reply=_reply;
    RETURN;
  END IF;
  _time:=round(extract(epoch FROM r.occurred_at)*1000)::bigint;
  DELETE FROM access.realm_thread_order WHERE data_epoch=_epoch AND realm=_realm AND reply=_reply
    AND (concept<>ALL(array_prepend('',COALESCE(r.concepts,'{}')))
      OR sort='top' AND period<>'all'
        AND r.occurred_at+CASE period WHEN 'week' THEN interval '7 days' ELSE interval '30 days' END<=_now);
  INSERT INTO access.realm_thread_order AS existing
    SELECT _epoch,_realm,o.sort,o.period,r.reply,r.placement,o.rank,o.time,o.expiry,c.concept
    FROM (VALUES
      ('new','all',r.new_epoch::double precision,-r.new_sequence,'infinity'::timestamptz),
      ('best','all',-(sign(r.score)*log(1+abs(r.score::double precision))+_time/86400000.0),-_time,'infinity'::timestamptz),
      ('top','all',-r.score::double precision,-_time,'infinity'::timestamptz),
      ('top','week',-r.score::double precision,-_time,r.occurred_at+interval '7 days'),
      ('top','month',-r.score::double precision,-_time,r.occurred_at+interval '30 days')) o(sort,period,rank,time,expiry)
    CROSS JOIN unnest(array_prepend('',COALESCE(r.concepts,'{}'))) c(concept)
    WHERE o.expiry>_now
  ON CONFLICT(data_epoch,realm,sort,period,reply,concept) DO UPDATE SET placement=EXCLUDED.placement,
    rank_key=EXCLUDED.rank_key,time_key=EXCLUDED.time_key,expires_at=EXCLUDED.expires_at
  WHERE (existing.placement,existing.rank_key,existing.time_key,existing.expires_at)
    IS DISTINCT FROM (EXCLUDED.placement,EXCLUDED.rank_key,EXCLUDED.time_key,EXCLUDED.expires_at);
END $$;
