-- Seven UTC days of member changes and discussion placements form a bounded
-- directory projection. An empty epoch denotes membership; posts keep the
-- Home projection's epoch so a rebuild never double-counts old feed rows.
CREATE TABLE access.realm_growth_day (
    realm text NOT NULL,
    day date NOT NULL,
    data_epoch text NOT NULL,
    members integer NOT NULL DEFAULT 0,
    posts integer NOT NULL DEFAULT 0,
    PRIMARY KEY (realm, day, data_epoch)
);
CREATE INDEX realm_growth_recent ON access.realm_growth_day (day, realm);
CREATE TABLE access.realm_growth_position (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO access.realm_growth_position DEFAULT VALUES;

INSERT INTO access.realm_growth_day (realm, day, data_epoch, members)
SELECT realm, day, '', sum(delta)::integer FROM (
    SELECT m.owner_subject AS realm, (h.changed_at AT TIME ZONE 'UTC')::date AS day,
      CASE WHEN h.state = 'joined' THEN 1 ELSE -1 END AS delta
      FROM access.membership_history h JOIN access.membership m ON m.id = h.membership_id
      WHERE m.kind = 'realm' AND h.changed_at >= now() - interval '7 days'
    UNION ALL
    SELECT m.owner_subject, (h.changed_at AT TIME ZONE 'UTC')::date,
      CASE WHEN h.state = 'joined' THEN 1 ELSE -1 END
      FROM access.private_membership_history h JOIN access.private_membership m ON m.id = h.membership_id
      WHERE m.kind = 'realm' AND h.changed_at >= now() - interval '7 days'
) events GROUP BY realm, day;

INSERT INTO access.realm_growth_day (realm, day, data_epoch, posts)
SELECT realm, (occurred_at AT TIME ZONE 'UTC')::date, data_epoch, count(*)::integer
  FROM access.feed_item WHERE kind = 'discussion' AND realm IS NOT NULL
    AND occurred_at >= now() - interval '7 days'
  GROUP BY realm, (occurred_at AT TIME ZONE 'UTC')::date, data_epoch
ON CONFLICT (realm, day, data_epoch) DO UPDATE SET posts = EXCLUDED.posts;

CREATE FUNCTION access.record_realm_member_growth() RETURNS trigger LANGUAGE plpgsql AS $$
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
      UPDATE access.realm_growth_position SET revision = gen_random_uuid() WHERE singleton;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER realm_public_growth AFTER INSERT OR UPDATE OR DELETE ON access.membership
  FOR EACH ROW EXECUTE FUNCTION access.record_realm_member_growth();
CREATE TRIGGER realm_private_growth AFTER INSERT OR UPDATE OR DELETE ON access.private_membership
  FOR EACH ROW EXECUTE FUNCTION access.record_realm_member_growth();

CREATE FUNCTION access.record_realm_post_growth() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF changed THEN UPDATE access.realm_growth_position SET revision = gen_random_uuid() WHERE singleton; END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER realm_post_growth AFTER INSERT OR UPDATE OR DELETE ON access.feed_item
  FOR EACH ROW EXECUTE FUNCTION access.record_realm_post_growth();
