-- Join supplies missing interest; it never replaces an existing explicit or
-- Library source or notification level. Inventory locking serializes Join,
-- Follow and recovery, including absence, aliases and the 10,000-follow budget.
CREATE OR REPLACE FUNCTION access.automatic_follow(who uuid, actor text, resource text, resource_kind text,
  origin text, enabled boolean, search_name text DEFAULT NULL, new_episode boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE prior access.follow%ROWTYPE;
BEGIN
  INSERT INTO access.follow_inventory(principal_id,revision) VALUES(who,gen_random_uuid()) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM access.follow_inventory WHERE principal_id=who FOR UPDATE;
  IF enabled THEN
    -- Read one existing identity from the bounded person inventory. Explicit
    -- and Library intent outrank Join; canonical settings break equal-source
    -- collisions. An alias supplies settings, not a fresh Join default.
    SELECT * INTO prior FROM access.follow WHERE principal_id=who
      AND (target=resource OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=resource))
      ORDER BY (source='explicit') DESC,(source='library') DESC,following DESC,
        (target=resource) DESC,changed_at DESC,target LIMIT 1;
    IF FOUND THEN
      IF origin='join' AND new_episode THEN
        -- Membership reads use the canonical Space slot. Move the proven
        -- winning settings in the same command, instead of discarding them.
        DELETE FROM access.follow WHERE principal_id=who AND target<>prior.target
          AND (target=resource OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=resource));
        IF prior.target<>resource THEN
          UPDATE access.follow SET target=resource,kind=resource_kind WHERE principal_id=who AND target=prior.target;
          prior.target:=resource;
        END IF;
      END IF;
      IF prior.following THEN RETURN true; END IF;
      -- Reconciliation respects opt-outs. A deliberate new Join can renew
      -- interest, but its Leave must still retain the original source and bell.
      IF prior.source='explicit' AND NOT (origin='join' AND new_episode)
        OR origin='join' AND prior.source='library' AND NOT new_episode THEN RETURN true; END IF;
    END IF;
    -- Automatic interest spends available budget; admission is never rejected.
    IF (SELECT active_count FROM access.follow_inventory WHERE principal_id=who)>=10000
      THEN RETURN false; END IF;
    IF prior.target IS NOT NULL THEN
      UPDATE access.follow SET following=true,revision=gen_random_uuid(),changed_at=clock_timestamp(),
        source=CASE WHEN origin='join' AND prior.source IN ('explicit','library') THEN prior.source ELSE origin END
        WHERE principal_id=who AND target=prior.target;
    ELSE
      INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level,source,name_key)
        VALUES(who,resource,resource_kind,actor,true,gen_random_uuid(),
          CASE WHEN origin='library' THEN 'all' ELSE 'highlights' END,origin,
          COALESCE(search_name,(SELECT name_key FROM access.follow_space_alias WHERE alias=resource)));
    END IF;
  ELSE
    -- Leave/Library removal affects only its own source, including legacy
    -- aliases awaiting recovery. Surviving follows keep their bell, pin and CAS.
    UPDATE access.follow SET following=false,revision=gen_random_uuid(),changed_at=clock_timestamp(),pin_position=NULL
      WHERE principal_id=who AND source=origin AND following
        AND (target=resource OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=resource));
  END IF;
  RETURN true;
END $$;

-- No speculative provenance backfill: membership history records membership,
-- not its prior Follow state. Follow receipts have neither a timestamp/order
-- nor a link from the automatically replaced head to its predecessor. An old
-- explicit receipt may precede a later opt-out, and a Library head has no such
-- receipt. Sources overwritten (or alias settings deleted) by migration 1014's
-- function cannot be recovered from this evidence alone. Retain those rows
-- unchanged until an authoritative predecessor snapshot is available.
