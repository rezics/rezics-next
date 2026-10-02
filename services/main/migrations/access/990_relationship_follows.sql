-- One person/target slot. A new Join renews interest; recovery and Library
-- preserve later explicit choices. Page size is independent of budget.
ALTER TABLE access.follow DROP CONSTRAINT follow_kind_check;
ALTER TABLE access.follow ADD CONSTRAINT follow_kind_check CHECK (length(kind) BETWEEN 1 AND 2048),
  ADD COLUMN level text NOT NULL DEFAULT 'highlights' CHECK (level IN ('all','highlights','off')),
  ADD COLUMN source text NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit','join','library')),
  ADD COLUMN pin_position integer CHECK (pin_position BETWEEN 0 AND 9999),
  ADD COLUMN name_key text,
  ADD COLUMN changed_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE access.follow SET level = CASE WHEN kind = 'work' THEN 'all'
  WHEN kind = 'concept' THEN 'off' ELSE 'highlights' END;
ALTER TABLE access.follow_inventory DROP CONSTRAINT follow_inventory_active_count_check;
ALTER TABLE access.follow_inventory ADD CONSTRAINT follow_inventory_active_count_check
  CHECK (active_count BETWEEN 0 AND 10000);
CREATE INDEX follow_pins ON access.follow(principal_id,pin_position,target) WHERE following;
CREATE TABLE access.follow_activity(target text PRIMARY KEY,activity_at timestamptz NOT NULL);
-- Capability identity is projected from the admitted graph by the follow owner.
-- Mapping a Realm/Zone never grants disclosure or membership.
CREATE TABLE access.follow_space_alias (
  alias text PRIMARY KEY,
  space text NOT NULL,
  realm text NOT NULL,
  name_key text
);
CREATE INDEX follow_space_identity ON access.follow_space_alias(space,alias);

-- Every writer (including merge, Join and migration) uses the same budget and
-- cursor revision. The inventory lock serializes absence and concurrent adds.
CREATE FUNCTION access.follow_inventory_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE who uuid; delta integer;
BEGIN
  who := CASE WHEN TG_OP = 'DELETE' THEN OLD.principal_id ELSE NEW.principal_id END;
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM access.principal WHERE id=who) THEN RETURN NULL; END IF;
  delta := CASE WHEN TG_OP = 'DELETE' THEN -OLD.following::integer
    WHEN TG_OP = 'INSERT' THEN NEW.following::integer
    ELSE NEW.following::integer - OLD.following::integer END;
  INSERT INTO access.follow_inventory(principal_id,revision) VALUES(who,gen_random_uuid()) ON CONFLICT DO NOTHING;
  UPDATE access.follow_inventory SET active_count=active_count+delta,revision=gen_random_uuid() WHERE principal_id=who;
  RETURN NULL;
END $$;
CREATE TRIGGER follow_inventory_change AFTER INSERT OR UPDATE OR DELETE ON access.follow
  FOR EACH ROW EXECUTE FUNCTION access.follow_inventory_change();

CREATE FUNCTION access.automatic_follow(who uuid, actor text, resource text, resource_kind text,
  origin text, enabled boolean, search_name text DEFAULT NULL, new_episode boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.follow_inventory(principal_id,revision) VALUES(who,gen_random_uuid()) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM access.follow_inventory WHERE principal_id=who FOR UPDATE;
  IF enabled THEN
    IF NOT (origin='join' AND new_episode) AND EXISTS(SELECT 1 FROM access.follow WHERE principal_id=who AND source='explicit'
      AND (target=resource OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=resource)))
      THEN RETURN true; END IF;
    IF origin='join' AND new_episode THEN
      DELETE FROM access.follow WHERE principal_id=who AND target<>resource
        AND target IN (SELECT alias FROM access.follow_space_alias WHERE space=resource);
    END IF;
    -- Automatic interest spends available budget; admission is never rejected.
    IF (SELECT active_count FROM access.follow_inventory WHERE principal_id=who)>=10000
      AND NOT EXISTS(SELECT 1 FROM access.follow WHERE principal_id=who AND target=resource AND following)
      THEN RETURN false; END IF;
    INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level,source,name_key)
      VALUES(who,resource,resource_kind,actor,true,gen_random_uuid(),
        CASE WHEN origin='library' THEN 'all' ELSE 'highlights' END,origin,
        COALESCE(search_name,(SELECT name_key FROM access.follow_space_alias WHERE alias=resource)))
      ON CONFLICT(principal_id,target) DO UPDATE SET following=true,revision=gen_random_uuid(),
        changed_at=clock_timestamp(),source=EXCLUDED.source
      WHERE (origin='join' AND new_episode) OR access.follow.source<>'explicit' AND NOT access.follow.following;
  ELSE
    UPDATE access.follow SET following=false,revision=gen_random_uuid(),changed_at=clock_timestamp(),pin_position=NULL
      WHERE principal_id=who AND target=resource AND source=origin AND following;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION access.membership_follow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE who uuid; actor text; resource text; joined boolean; new_episode boolean := false;
BEGIN
  IF NEW.kind <> 'realm' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='private_membership' THEN
    who:=NEW.principal_id;
    SELECT a.agent_id INTO actor FROM access.agent_provision a WHERE a.principal_id=who
      AND a.agent_kind='person' AND a.state='active' ORDER BY a.agent_id LIMIT 1;
  ELSE
    SELECT a.principal_id,a.agent_id INTO who,actor FROM access.agent_provision a
      WHERE a.agent_id=NEW.member_subject AND a.agent_kind='person' AND a.state='active';
  END IF;
  IF who IS NULL OR actor IS NULL THEN RETURN NULL; END IF;
  SELECT space INTO resource FROM access.follow_space_alias WHERE alias=NEW.owner_subject;
  -- A missing graph projection is retained for bounded recovery; new self-Join
  -- installs the exact mapping before the membership statement.
  IF resource IS NULL THEN RETURN NULL; END IF;
  joined := NEW.state='joined' OR EXISTS(SELECT 1 FROM access.membership m
    JOIN access.agent_provision a ON a.agent_id=m.member_subject
    WHERE m.kind='realm' AND m.owner_subject=NEW.owner_subject AND m.state='joined' AND a.principal_id=who)
    OR EXISTS(SELECT 1 FROM access.private_membership m WHERE m.kind='realm'
      AND m.owner_subject=NEW.owner_subject AND m.state='joined' AND m.principal_id=who);
  IF NEW.state='joined' THEN
    IF TG_OP='INSERT' THEN new_episode:=true;
    ELSE new_episode:=OLD.state<>'joined'; END IF;
  END IF;
  PERFORM access.automatic_follow(who,actor,resource,'space','join',joined,NULL,new_episode);
  RETURN NULL;
END $$;
CREATE TRIGGER membership_follow AFTER INSERT OR UPDATE OF state ON access.membership
  FOR EACH ROW EXECUTE FUNCTION access.membership_follow();
CREATE TRIGGER private_membership_follow AFTER INSERT OR UPDATE OF state ON access.private_membership
  FOR EACH ROW EXECUTE FUNCTION access.membership_follow();

-- A bounded reconciliation of the existing durable Content standing slots.
-- No distributed transaction or process-local callback is a recovery record.
CREATE TABLE access.library_follow_position(agent text NOT NULL,work text NOT NULL,version bigint NOT NULL,
  PRIMARY KEY(agent,work));
CREATE TABLE access.relationship_recovery_cursor(id boolean PRIMARY KEY DEFAULT true CHECK(id),
  library_agent text NOT NULL DEFAULT '',library_work text NOT NULL DEFAULT '',
  space_after_principal uuid,space_after_target text NOT NULL DEFAULT '',member_after uuid);
INSERT INTO access.relationship_recovery_cursor(id) VALUES(true);

-- Private Space interest pauses only after the current membership is lost.
CREATE FUNCTION access.follow_space_notifying(who uuid, resource text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM access.follow_space_alias alias
    JOIN access.realm_admin_settings settings ON settings.realm=alias.realm
    WHERE (alias.alias=resource OR alias.space=resource) AND settings.visibility='private'
    AND NOT EXISTS(SELECT 1 FROM access.private_membership m WHERE m.principal_id=who
      AND m.owner_subject=alias.realm AND m.kind='realm' AND m.state='joined')
    AND NOT EXISTS(SELECT 1 FROM access.membership m JOIN access.agent_provision a ON a.agent_id=m.member_subject
      WHERE a.principal_id=who AND a.agent_kind='person' AND a.state='active'
        AND m.owner_subject=alias.realm AND m.kind='realm' AND m.state='joined'))
$$;
CREATE INDEX follow_activity_retention ON access.follow_activity(activity_at,target);
