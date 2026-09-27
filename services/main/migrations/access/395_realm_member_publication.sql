-- Access owns membership; public profiles disclose only the aggregate when
-- their manager selects exact counts. Count joined membership identities across
-- both public Agent and private principal participation, never expose a roster.
ALTER TABLE access.baseline_admission ADD COLUMN realm_membership text;
CREATE TABLE access.realm_member_count (
    realm text PRIMARY KEY,
    value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE access.realm_count_position (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision bigint NOT NULL DEFAULT 0
);
INSERT INTO access.realm_count_position DEFAULT VALUES;
INSERT INTO access.realm_member_count (realm, value)
SELECT owner_subject, count(*) FROM (
    SELECT owner_subject FROM access.membership WHERE kind = 'realm' AND state = 'joined'
    UNION ALL
    SELECT owner_subject FROM access.private_membership WHERE kind = 'realm' AND state = 'joined'
) members GROUP BY owner_subject;

CREATE FUNCTION access.update_realm_member_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta integer; realm_id text;
BEGIN
    IF TG_OP = 'UPDATE' AND (OLD.kind, OLD.owner_subject) IS DISTINCT FROM (NEW.kind, NEW.owner_subject) THEN
        RAISE EXCEPTION 'membership owner is immutable' USING ERRCODE = '23514';
    END IF;
    realm_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.owner_subject ELSE NEW.owner_subject END;
    delta := CASE WHEN TG_OP <> 'DELETE' AND NEW.kind = 'realm' AND NEW.state = 'joined' THEN 1 ELSE 0 END
           - CASE WHEN TG_OP <> 'INSERT' AND OLD.kind = 'realm' AND OLD.state = 'joined' THEN 1 ELSE 0 END;
    IF delta <> 0 THEN
        -- One shared order makes count-page cursors fence concurrent joins/leaves.
        UPDATE access.realm_count_position SET revision = revision + 1 WHERE singleton;
        INSERT INTO access.realm_member_count (realm) VALUES (realm_id) ON CONFLICT DO NOTHING;
        UPDATE access.realm_member_count SET value = value + delta, revision = revision + 1 WHERE realm = realm_id;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER realm_public_member_count AFTER INSERT OR UPDATE OR DELETE ON access.membership
    FOR EACH ROW EXECUTE FUNCTION access.update_realm_member_count();
CREATE TRIGGER realm_private_member_count AFTER INSERT OR UPDATE OR DELETE ON access.private_membership
    FOR EACH ROW EXECUTE FUNCTION access.update_realm_member_count();
