-- These revisions are equality fences, never delivery offsets. A change row
-- replaces the writer's singleton update. Two bounded index probes produce a
-- fence: the last stable key, plus the snapshot only while visible changes are
-- above xmin. Including that snapshot catches a late lower-xid commit even
-- while another, still older transaction keeps xmin pinned. Once it drains,
-- unrelated writes no longer invalidate the fence. Recovery generation leads
-- xid so a logical restore cannot hide changes behind its old transaction IDs.
-- No reader folds rows, takes a write lock or scans the change history.

CREATE TABLE access.site_moderation_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch bigint NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX site_moderation_change_order ON access.site_moderation_change(epoch,xid,id);
CREATE FUNCTION access.record_site_moderation_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.site_moderation_changed',true) = 'on' THEN RETURN; END IF;
  INSERT INTO access.site_moderation_change(epoch) SELECT generation FROM access.recovery_fence WHERE id FOR SHARE;
  PERFORM set_config('rezics.site_moderation_changed','on',true);
END $$;
CREATE FUNCTION access.site_moderation_basis() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_current_snapshot() AS snapshot FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',p.revision::text,h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.site_moderation_change c
      WHERE (c.epoch,c.xid) < (h.generation,pg_snapshot_xmin(h.snapshot))
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    CASE WHEN EXISTS (SELECT 1 FROM access.site_moderation_change c
      WHERE (c.epoch,c.xid) >= (h.generation,pg_snapshot_xmin(h.snapshot)))
      THEN h.snapshot::text END),'UTF8')),'hex')
  FROM access.site_moderation_position p CROSS JOIN horizon h WHERE p.id;
$$;

CREATE TABLE access.realm_count_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch bigint NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX realm_count_change_order ON access.realm_count_change(epoch,xid,id);
CREATE FUNCTION access.record_realm_count_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.realm_count_changed',true) = 'on' THEN RETURN; END IF;
  INSERT INTO access.realm_count_change(epoch) SELECT generation FROM access.recovery_fence WHERE id FOR SHARE;
  PERFORM set_config('rezics.realm_count_changed','on',true);
END $$;
CREATE FUNCTION access.realm_count_basis() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_current_snapshot() AS snapshot FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',p.revision::text,h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.realm_count_change c
      WHERE (c.epoch,c.xid) < (h.generation,pg_snapshot_xmin(h.snapshot))
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    CASE WHEN EXISTS (SELECT 1 FROM access.realm_count_change c
      WHERE (c.epoch,c.xid) >= (h.generation,pg_snapshot_xmin(h.snapshot)))
      THEN h.snapshot::text END),'UTF8')),'hex')
  FROM access.realm_count_position p CROSS JOIN horizon h WHERE p.singleton;
$$;

CREATE TABLE access.realm_growth_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch bigint NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX realm_growth_change_order ON access.realm_growth_change(epoch,xid,id);
CREATE FUNCTION access.record_realm_growth_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.realm_growth_changed',true) = 'on' THEN RETURN; END IF;
  INSERT INTO access.realm_growth_change(epoch) SELECT generation FROM access.recovery_fence WHERE id FOR SHARE;
  PERFORM set_config('rezics.realm_growth_changed','on',true);
END $$;
CREATE FUNCTION access.realm_growth_basis() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_current_snapshot() AS snapshot FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',p.revision::text,h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.realm_growth_change c
      WHERE (c.epoch,c.xid) < (h.generation,pg_snapshot_xmin(h.snapshot))
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    CASE WHEN EXISTS (SELECT 1 FROM access.realm_growth_change c
      WHERE (c.epoch,c.xid) >= (h.generation,pg_snapshot_xmin(h.snapshot)))
      THEN h.snapshot::text END),'UTF8')),'hex')
  FROM access.realm_growth_position p CROSS JOIN horizon h WHERE p.singleton;
$$;

CREATE OR REPLACE FUNCTION access.advance_site_moderation_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authority_kind = 'platform' THEN PERFORM access.record_site_moderation_change(); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access.update_realm_member_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta integer; realm_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.kind,OLD.owner_subject) IS DISTINCT FROM (NEW.kind,NEW.owner_subject) THEN
    RAISE EXCEPTION 'membership owner is immutable' USING ERRCODE = '23514';
  END IF;
  realm_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.owner_subject ELSE NEW.owner_subject END;
  delta := CASE WHEN TG_OP <> 'DELETE' AND NEW.kind = 'realm' AND NEW.state = 'joined' THEN 1 ELSE 0 END
    - CASE WHEN TG_OP <> 'INSERT' AND OLD.kind = 'realm' AND OLD.state = 'joined' THEN 1 ELSE 0 END;
  IF delta <> 0 THEN
    -- The directory builder shares only this Realm's lock before reading its
    -- count. Missing count rows need the same protection as existing ones.
    PERFORM pg_advisory_xact_lock(hashtextextended('realm-count:' || realm_id,0));
    PERFORM access.record_realm_count_change();
    INSERT INTO access.realm_member_count(realm) VALUES (realm_id) ON CONFLICT DO NOTHING;
    UPDATE access.realm_member_count SET value = value + delta,revision = revision + 1 WHERE realm = realm_id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.record_realm_member_growth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta integer; realm_id text;
BEGIN
    realm_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.owner_subject ELSE NEW.owner_subject END;
    delta := CASE WHEN TG_OP <> 'DELETE' AND NEW.kind = 'realm' AND NEW.state = 'joined' THEN 1 ELSE 0 END
      - CASE WHEN TG_OP <> 'INSERT' AND OLD.kind = 'realm' AND OLD.state = 'joined' THEN 1 ELSE 0 END;
    IF delta <> 0 THEN
      INSERT INTO access.realm_growth_day (realm, day, data_epoch, members)
        VALUES (realm_id, (now() AT TIME ZONE 'UTC')::date, '', delta)
      ON CONFLICT (realm, day, data_epoch) DO UPDATE
        SET members = access.realm_growth_day.members + EXCLUDED.members;
      PERFORM access.record_realm_growth_change();
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.record_realm_post_growth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean := false;
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.kind = 'discussion' AND OLD.realm IS NOT NULL
      AND (TG_OP = 'DELETE' OR (OLD.realm, OLD.data_epoch, OLD.occurred_at, OLD.kind)
        IS DISTINCT FROM (NEW.realm, NEW.data_epoch, NEW.occurred_at, NEW.kind)) THEN
      INSERT INTO access.realm_growth_day (realm, day, data_epoch, posts)
        VALUES (OLD.realm, (OLD.occurred_at AT TIME ZONE 'UTC')::date, OLD.data_epoch, -1)
      ON CONFLICT (realm, day, data_epoch) DO UPDATE
        SET posts = access.realm_growth_day.posts - 1;
      changed := true;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.kind = 'discussion' AND NEW.realm IS NOT NULL
      AND (TG_OP = 'INSERT' OR (OLD.realm, OLD.data_epoch, OLD.occurred_at, OLD.kind)
        IS DISTINCT FROM (NEW.realm, NEW.data_epoch, NEW.occurred_at, NEW.kind)) THEN
      INSERT INTO access.realm_growth_day (realm, day, data_epoch, posts)
        VALUES (NEW.realm, (NEW.occurred_at AT TIME ZONE 'UTC')::date, NEW.data_epoch, 1)
      ON CONFLICT (realm, day, data_epoch) DO UPDATE
        SET posts = access.realm_growth_day.posts + 1;
      changed := true;
    END IF;
    IF changed THEN PERFORM access.record_realm_growth_change(); END IF;
    RETURN NULL;
END $$;

