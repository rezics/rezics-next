-- A vote changes a score, not a population. Population revisions bind page
-- cursors; a score change on one post must not invalidate every open page or
-- make votes on unrelated posts meet on one row. Keyset cursors tolerate it
-- (services/main/src/modules/feed/timeline.md, "Votes and paging").

-- Account deletion removes votes without touching the projection checkpoint.
CREATE OR REPLACE FUNCTION access.feed_vote_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.feed_item SET score = score - OLD.value,
    best_key = sign(score - OLD.value) * log(1 + abs(score - OLD.value))
      + extract(epoch FROM occurred_at) / 86400
    WHERE id = OLD.target;
  RETURN OLD;
END $$;

-- Keep a still-ranked reply's order rows in place: an unchanged row is not
-- rewritten and a score change updates only its rank key, so the per-Realm
-- revision below moves only when the population or its time/placement keys do.
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
    AND sort='top' AND period<>'all'
    AND r.occurred_at+CASE period WHEN 'week' THEN interval '7 days' ELSE interval '30 days' END<=_now;
  INSERT INTO access.realm_thread_order AS o
    SELECT _epoch,_realm,d.sort,d.period,r.reply,r.placement,d.rank_key,-_time,d.expires_at FROM (VALUES
      ('best','all',-(sign(r.score)*log(1+abs(r.score::double precision))+_time/86400000.0),'infinity'::timestamptz),
      ('top','all',-r.score::double precision,'infinity'::timestamptz),
      ('top','week',-r.score::double precision,r.occurred_at+interval '7 days'),
      ('top','month',-r.score::double precision,r.occurred_at+interval '30 days')) d(sort,period,rank_key,expires_at)
    WHERE d.expires_at>_now
  ON CONFLICT(data_epoch,realm,sort,period,reply) DO UPDATE SET placement=EXCLUDED.placement,
    rank_key=EXCLUDED.rank_key,time_key=EXCLUDED.time_key,expires_at=EXCLUDED.expires_at
  WHERE (o.placement,o.rank_key,o.time_key,o.expires_at)
    IS DISTINCT FROM (EXCLUDED.placement,EXCLUDED.rank_key,EXCLUDED.time_key,EXCLUDED.expires_at);
END $$;

-- A rank-key-only update is a score change: it leaves the Realm revision, so
-- votes in one Realm no longer serialize on its access.realm_thread_state row.
CREATE OR REPLACE FUNCTION access.realm_thread_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    INSERT INTO access.realm_thread_state VALUES(OLD.data_epoch,OLD.realm,1)
      ON CONFLICT(data_epoch,realm) DO UPDATE SET revision=access.realm_thread_state.revision+1;
  ELSIF TG_OP='INSERT' OR (OLD.data_epoch,OLD.realm,OLD.sort,OLD.period,OLD.reply,OLD.placement,OLD.time_key,OLD.expires_at)
    IS DISTINCT FROM (NEW.data_epoch,NEW.realm,NEW.sort,NEW.period,NEW.reply,NEW.placement,NEW.time_key,NEW.expires_at) THEN
    INSERT INTO access.realm_thread_state VALUES(NEW.data_epoch,NEW.realm,1)
      ON CONFLICT(data_epoch,realm) DO UPDATE SET revision=access.realm_thread_state.revision+1;
  END IF;
  RETURN NULL;
END $$;
