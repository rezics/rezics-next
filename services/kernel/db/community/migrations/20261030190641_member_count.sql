-- migrate:up
-- Numeric source positions contain no account identity. Closed history is never
-- visited by the seed; the partial index is the actual open source keyspace.
CREATE SEQUENCE community.realm_member_count_key;
ALTER TABLE community.realm_member ADD COLUMN member_count_key bigint;
ALTER TABLE community.realm_member ALTER COLUMN member_count_key SET DEFAULT nextval('community.realm_member_count_key');
ALTER SEQUENCE community.realm_member_count_key OWNED BY community.realm_member.member_count_key;
CREATE INDEX realm_member_count_unkeyed ON community.realm_member(route, realm_id, account_id)
  WHERE upper_inf(valid) AND member_count_key IS NULL;
CREATE INDEX realm_member_count_open ON community.realm_member(route, realm_id, member_count_key) WHERE upper_inf(valid);
CREATE INDEX realm_member_count_end ON community.realm_member(route, realm_id, (upper(valid)) DESC) WHERE NOT upper_inf(valid);

CREATE TABLE community.realm_member_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  count bigint NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND 9007199254740991),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  keyed boolean NOT NULL DEFAULT true,
  initialized boolean NOT NULL DEFAULT false,
  removal_coverage boolean NOT NULL DEFAULT true,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  frontier bigint NOT NULL CHECK (frontier >= 0),
  horizon timestamptz NOT NULL DEFAULT '-infinity',
  PRIMARY KEY(route, realm_id),
  CHECK (route = get_byte(uuid_send(realm_id),10)*256 + get_byte(uuid_send(realm_id),11)),
  CHECK (cursor <= frontier),
  CHECK (NOT initialized OR keyed)
);
CREATE INDEX realm_member_count_pending ON community.realm_member_count(route, realm_id) WHERE NOT initialized;

-- Finite deployment inventory, independent of the number of old intervals.
-- New Realm inserts and all source writers install their own controls.
CREATE TABLE community.realm_member_count_install (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  cursor_route integer NOT NULL,
  cursor_id uuid NOT NULL,
  frontier_route integer NOT NULL,
  frontier_id uuid NOT NULL,
  complete boolean NOT NULL DEFAULT false
);
INSERT INTO community.realm_member_count_install(partition_no,cursor_route,cursor_id,frontier_route,frontier_id)
SELECT p, p*16, '00000000-0000-0000-0000-000000000000'::uuid, r.route, r.realm_id
FROM generate_series(0,4095) p
CROSS JOIN LATERAL (
 SELECT route,realm_id FROM community.realm
 WHERE route BETWEEN p*16 AND p*16+15 ORDER BY route DESC,realm_id DESC LIMIT 1
) r;

CREATE FUNCTION community.ensure_realm_member_count(r integer, id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE cut bigint; until_at timestamptz; has_unkeyed boolean;
BEGIN
  -- Exact indexed endpoints, including explicit infinite timestamps. Such an
  -- unsupported upper frontier stays unknown instead of pretending it elapsed.
  SELECT COALESCE((SELECT member_count_key FROM community.realm_member
    WHERE route=r AND realm_id=id AND upper_inf(valid) AND member_count_key IS NOT NULL
    ORDER BY member_count_key DESC LIMIT 1),0) INTO cut;
  SELECT COALESCE((SELECT upper(valid) FROM community.realm_member
    WHERE route=r AND realm_id=id AND NOT upper_inf(valid)
    ORDER BY upper(valid) DESC LIMIT 1),'-infinity'::timestamptz) INTO until_at;
  SELECT EXISTS(SELECT 1 FROM community.realm_member WHERE route=r AND realm_id=id
    AND upper_inf(valid) AND member_count_key IS NULL LIMIT 1) INTO has_unkeyed;
  INSERT INTO community.realm_member_count(route,realm_id,frontier,keyed,initialized,horizon)
  VALUES(r,id,cut,NOT has_unkeyed,cut=0 AND NOT has_unkeyed,until_at) ON CONFLICT(route,realm_id) DO NOTHING;
END;
$$;

CREATE FUNCTION community.lock_realm_member_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r integer; id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ((NEW.route,NEW.realm_id) IS DISTINCT FROM (OLD.route,OLD.realm_id)
      OR (OLD.member_count_key IS NOT NULL AND NEW.member_count_key IS DISTINCT FROM OLD.member_count_key)) THEN
    RAISE EXCEPTION 'Membership source key is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN r:=OLD.route; id:=OLD.realm_id;
  ELSE r:=NEW.route; id:=NEW.realm_id; END IF;
  -- Fast path avoids endpoint probes for every covered source change.
  PERFORM 1 FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM community.ensure_realm_member_count(r,id);
    PERFORM 1 FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.member_count_key IS NULL AND upper_inf(NEW.valid) THEN
    NEW.member_count_key:=nextval('community.realm_member_count_key');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_member_count_lock BEFORE INSERT OR UPDATE OR DELETE ON community.realm_member
FOR EACH ROW EXECUTE FUNCTION community.lock_realm_member_count();

CREATE FUNCTION community.change_realm_member_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r integer; id uuid; k bigint; delta integer:=0; h timestamptz:='-infinity'; c community.realm_member_count;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'member_count_key') IS NOT DISTINCT FROM
      (to_jsonb(OLD)-'member_count_key') THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN r:=OLD.route; id:=OLD.realm_id; k:=OLD.member_count_key;
  ELSE r:=NEW.route; id:=NEW.realm_id; k:=NEW.member_count_key; END IF;
  SELECT * INTO STRICT c FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  IF TG_OP<>'INSERT' THEN
    IF OLD.role='member' AND upper_inf(OLD.valid) THEN delta:=delta-1; END IF;
    h:=GREATEST(h,COALESCE(lower(OLD.valid),'-infinity'),COALESCE(upper(OLD.valid),'-infinity'));
  END IF;
  IF TG_OP<>'DELETE' THEN
    IF NEW.role='member' AND upper_inf(NEW.valid) THEN delta:=delta+1; END IF;
    h:=GREATEST(h,COALESCE(lower(NEW.valid),'-infinity'),COALESCE(upper(NEW.valid),'-infinity'));
  END IF;
  -- The unvisited part of the finite cut is read in its current state later.
  -- Already seeded keys and post-cut keys receive their actual delta exactly once.
  IF NOT c.keyed OR (NOT c.initialized AND k>c.cursor AND k<=c.frontier) THEN delta:=0; END IF;
  UPDATE community.realm_member_count SET count=count+delta,version=version+1,horizon=GREATEST(horizon,h)
  WHERE route=r AND realm_id=id;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER realm_member_count_change AFTER INSERT OR UPDATE OR DELETE ON community.realm_member
FOR EACH ROW EXECUTE FUNCTION community.change_realm_member_count();

CREATE FUNCTION community.create_realm_member_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community.ensure_realm_member_count(NEW.route,NEW.realm_id);
  UPDATE community.realm_member_count SET horizon=GREATEST(horizon,NEW.created_at)
  WHERE route=NEW.route AND realm_id=NEW.realm_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_member_count_create AFTER INSERT ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.create_realm_member_count();

-- Called only by native bounded upkeep, under the same control lock as writers.
CREATE FUNCTION community.seed_realm_member_count(r integer, id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE c community.realm_member_count; n integer; last_key bigint; added bigint; h timestamptz; source_key uuid;
BEGIN
  SELECT * INTO STRICT c FROM community.realm_member_count WHERE route=r AND realm_id=id FOR UPDATE;
  IF c.initialized THEN RETURN false; END IF;
  IF NOT c.keyed THEN
    -- Install positions only on fifty raw current source keys. Existing closed
    -- histories remain untouched. This stores no account-bearing seed cursor.
    n:=0;
    FOR source_key IN
      SELECT account_id FROM community.realm_member
      WHERE route=r AND realm_id=id AND upper_inf(valid) AND member_count_key IS NULL
      ORDER BY account_id LIMIT 50
    LOOP
      n:=n+1;
      UPDATE community.realm_member SET member_count_key=nextval('community.realm_member_count_key')
      WHERE route=r AND realm_id=id AND account_id=source_key AND upper_inf(valid) AND member_count_key IS NULL;
    END LOOP;
    IF n<50 THEN
      SELECT COALESCE((SELECT member_count_key FROM community.realm_member
        WHERE route=r AND realm_id=id AND upper_inf(valid) AND member_count_key IS NOT NULL
        ORDER BY member_count_key DESC LIMIT 1),0) INTO last_key;
      UPDATE community.realm_member_count SET keyed=true,frontier=last_key,initialized=last_key=0
      WHERE route=r AND realm_id=id;
    END IF;
    RETURN true;
  END IF;
  WITH raw AS MATERIALIZED (
    SELECT member_count_key,role,valid FROM community.realm_member
    WHERE route=r AND realm_id=id AND upper_inf(valid)
      AND member_count_key>c.cursor AND member_count_key<=c.frontier
    ORDER BY member_count_key LIMIT 50
  ) SELECT count(*)::integer, max(member_count_key),
      count(*) FILTER (WHERE role='member'),max(lower(valid))
    INTO n,last_key,added,h FROM raw;
  UPDATE community.realm_member_count SET count=count+added,
    cursor=CASE WHEN n<50 THEN frontier ELSE last_key END,
    initialized=n<50, horizon=GREATEST(horizon,COALESCE(h,'-infinity'))
  WHERE route=r AND realm_id=id;
  RETURN n=50;
END;
$$;

CREATE FUNCTION community.guard_realm_member_count_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Membership removal requires covered row changes' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER realm_member_count_no_truncate BEFORE TRUNCATE ON community.realm_member
FOR EACH STATEMENT EXECUTE FUNCTION community.guard_realm_member_count_truncate();

-- migrate:down
-- Forward only: source coverage and durable seed positions must survive replay.
