-- Shared Realm populations, following the Home admitted-score/target indexes.
-- References retain no words and grant no disclosure. All backfills seek a saved
-- key; request LIMIT addresses the maintained population, never a raw cohort.
ALTER TABLE access.feed_item ADD COLUMN realm_thread_indexed boolean NOT NULL DEFAULT false;
CREATE INDEX realm_thread_backfill ON access.feed_item(data_epoch,id)
  WHERE kind IN ('reply','discussion') AND NOT realm_thread_indexed;

CREATE TABLE access.realm_thread_checkpoint (
  data_epoch text PRIMARY KEY,
  sequence numeric NOT NULL DEFAULT 0,
  after_event text NOT NULL DEFAULT '',
  content_epoch uuid NOT NULL,
  content_sequence bigint NOT NULL DEFAULT 0
);
CREATE TABLE access.realm_thread_dirty (
  data_epoch text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reply','work','realm','parent')),
  resource text NOT NULL,
  after_key text NOT NULL DEFAULT '',
  PRIMARY KEY(data_epoch,kind,resource)
);
CREATE TABLE access.realm_thread_reference (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  reply text NOT NULL,
  placement text NOT NULL,
  parent text,
  thread text NOT NULL,
  work text NOT NULL,
  occurred_at timestamptz NOT NULL,
  activity_at timestamptz NOT NULL,
  score integer NOT NULL DEFAULT 0,
  replies integer NOT NULL DEFAULT 0,
  active boolean NOT NULL,
  PRIMARY KEY(data_epoch,realm,reply)
);
CREATE INDEX realm_thread_placement ON access.realm_thread_reference(data_epoch,placement);
CREATE INDEX realm_thread_work ON access.realm_thread_reference(data_epoch,work,realm,reply);
CREATE INDEX realm_thread_reply ON access.realm_thread_reference(data_epoch,reply,realm);
CREATE INDEX realm_thread_parent ON access.realm_thread_reference(data_epoch,parent,realm,reply);
CREATE INDEX realm_thread_fence_work ON access.realm_thread_reference(work);
CREATE INDEX realm_thread_fence_reply ON access.realm_thread_reference(reply);
CREATE INDEX realm_thread_children ON access.realm_thread_reference(data_epoch,realm,thread,reply) WHERE active AND parent IS NOT NULL;
CREATE INDEX realm_thread_activity ON access.realm_thread_reference(data_epoch,realm,thread,occurred_at DESC)
  WHERE active AND parent IS NOT NULL;
CREATE TABLE access.realm_thread_state (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(data_epoch,realm)
);
CREATE TABLE access.realm_thread_order (
  data_epoch text NOT NULL,
  realm text NOT NULL,
  sort text NOT NULL CHECK(sort IN ('best','top')),
  period text NOT NULL CHECK(period IN ('week','month','all')),
  reply text NOT NULL,
  placement text COLLATE "C" NOT NULL,
  -- Ascending normalized tuple admits one B-tree range condition on later pages.
  rank_key double precision NOT NULL,
  time_key bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(data_epoch,realm,sort,period,reply),
  FOREIGN KEY(data_epoch,realm,reply) REFERENCES access.realm_thread_reference(data_epoch,realm,reply) ON DELETE CASCADE
);
CREATE INDEX realm_thread_seek ON access.realm_thread_order
  (data_epoch,realm,sort,period,rank_key,time_key,placement) INCLUDE(reply);
CREATE INDEX realm_thread_expiry ON access.realm_thread_order(expires_at,data_epoch,realm,sort,period,reply)
  WHERE period <> 'all';
CREATE INDEX realm_thread_period_expiry ON access.realm_thread_order(data_epoch,realm,sort,period,expires_at);

CREATE FUNCTION access.refresh_realm_thread_order(_epoch text,_realm text,_reply text) RETURNS void LANGUAGE plpgsql AS $$
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
  INSERT INTO access.realm_thread_order VALUES
    (_epoch,_realm,'best','all',r.reply,r.placement,
      -(sign(r.score)*log(1+abs(r.score::double precision))+_time/86400000.0),-_time,'infinity'),
    (_epoch,_realm,'top','all',r.reply,r.placement,-r.score::double precision,-_time,'infinity');
  INSERT INTO access.realm_thread_order
    SELECT _epoch,_realm,'top',p.period,r.reply,r.placement,-r.score::double precision,-_time,r.occurred_at+p.duration
    FROM (VALUES ('week',interval '7 days'),('month',interval '30 days')) p(period,duration)
    WHERE r.occurred_at+p.duration>clock_timestamp();
END $$;
CREATE FUNCTION access.realm_thread_reference_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM access.refresh_realm_thread_order(NEW.data_epoch,NEW.realm,NEW.reply);
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_reference_changed AFTER INSERT OR UPDATE ON access.realm_thread_reference
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_reference_changed();
CREATE FUNCTION access.realm_thread_parent_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.thread,OLD.active) IS NOT DISTINCT FROM (NEW.thread,NEW.active) THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
    SELECT NEW.data_epoch,'parent',NEW.reply WHERE EXISTS(SELECT 1 FROM access.realm_thread_reference child
      WHERE child.data_epoch=NEW.data_epoch AND child.parent=NEW.reply LIMIT 1)
    ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key='';
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_parent_changed AFTER INSERT OR UPDATE OF thread,active ON access.realm_thread_reference
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_parent_changed();
CREATE FUNCTION access.realm_thread_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    INSERT INTO access.realm_thread_state VALUES(OLD.data_epoch,OLD.realm,1)
      ON CONFLICT(data_epoch,realm) DO UPDATE SET revision=access.realm_thread_state.revision+1;
  ELSE
    INSERT INTO access.realm_thread_state VALUES(NEW.data_epoch,NEW.realm,1)
      ON CONFLICT(data_epoch,realm) DO UPDATE SET revision=access.realm_thread_state.revision+1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_order_changed AFTER INSERT OR UPDATE OR DELETE ON access.realm_thread_order
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_order_changed();
CREATE FUNCTION access.realm_thread_vote_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.realm_thread_reference SET score=NEW.score
    WHERE data_epoch=NEW.data_epoch AND placement=NEW.id AND score IS DISTINCT FROM NEW.score;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_vote_changed AFTER UPDATE OF score ON access.feed_item
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_vote_changed();

-- Strong Access revocations remove order rows in their own transaction, exactly
-- as admitted read rankings do. No denied prefix is searched by a request.
CREATE FUNCTION access.realm_thread_fence_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _resource text; r record;
BEGIN
  IF TG_TABLE_NAME='scope_gate' THEN
    _resource:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF _resource NOT LIKE 'work:read:%' THEN RETURN NULL; END IF;
    _resource:=substr(_resource,11);
  ELSE
    _resource:=CASE WHEN TG_OP='DELETE' THEN OLD.resource ELSE NEW.resource END;
  END IF;
  FOR r IN SELECT data_epoch,realm,reply FROM access.realm_thread_reference WHERE work=_resource OR reply=_resource LOOP
    PERFORM access.refresh_realm_thread_order(r.data_epoch,r.realm,r.reply);
  END LOOP;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='governance_enforcement' THEN
    -- Keep field binding inside its table branch: AND does not prevent
    -- PostgreSQL resolving OLD.resource against a scope_gate record.
    IF OLD.resource IS DISTINCT FROM NEW.resource THEN
      FOR r IN SELECT data_epoch,realm,reply FROM access.realm_thread_reference WHERE work=OLD.resource OR reply=OLD.resource LOOP
        PERFORM access.refresh_realm_thread_order(r.data_epoch,r.realm,r.reply);
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_governance_changed AFTER INSERT OR UPDATE OR DELETE ON access.governance_enforcement
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_fence_changed();
CREATE TRIGGER realm_thread_scope_changed AFTER INSERT OR UPDATE OR DELETE ON access.scope_gate
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_fence_changed();
