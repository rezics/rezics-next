-- Retain a version after release so a hold's add/release cannot look unchanged.
-- The trigger covers both public intake and staff holds in their owner transaction.
CREATE TABLE access.governance_preservation_delivery_head (
    target_resource text PRIMARY KEY,
    version bigint NOT NULL CHECK (version > 0),
    active_holds bigint NOT NULL CHECK (active_holds >= 0)
);
INSERT INTO access.governance_preservation_delivery_head (target_resource, version, active_holds)
SELECT target_resource, 1, count(*) FILTER (WHERE released_at IS NULL)
FROM access.governance_preservation_hold GROUP BY target_resource;

CREATE FUNCTION access.advance_preservation_delivery_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    old_active bigint := 0;
    new_active bigint := 0;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_active := CASE WHEN OLD.released_at IS NULL THEN 1 ELSE 0 END;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_active := CASE WHEN NEW.released_at IS NULL THEN 1 ELSE 0 END;
    END IF;
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.target_resource <> NEW.target_resource) THEN
        UPDATE access.governance_preservation_delivery_head
        SET version = version + 1, active_holds = active_holds - old_active
        WHERE target_resource = OLD.target_resource;
        old_active := 0;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        INSERT INTO access.governance_preservation_delivery_head (target_resource, version, active_holds)
        VALUES (NEW.target_resource, 1, new_active)
        ON CONFLICT (target_resource) DO UPDATE
        SET version = governance_preservation_delivery_head.version + 1,
            active_holds = governance_preservation_delivery_head.active_holds + new_active - old_active;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER governance_preservation_delivery_version
AFTER INSERT OR DELETE OR UPDATE OF target_resource, released_at ON access.governance_preservation_hold
FOR EACH ROW EXECUTE FUNCTION access.advance_preservation_delivery_head();
