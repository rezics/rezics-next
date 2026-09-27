-- Realm queue pages bind a durable Access position. Updates serialize on this
-- row, so a final FOR SHARE read fences concurrent queue changes until commit.
CREATE TABLE access.realm_management_read_revision (
    realm text PRIMARY KEY CHECK (realm ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    revision bigint NOT NULL CHECK (revision >= 0)
);

CREATE FUNCTION access.advance_realm_management_read_revision(realm_id text)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO access.realm_management_read_revision (realm, revision)
    VALUES (realm_id, 1)
    ON CONFLICT (realm) DO UPDATE
        SET revision = access.realm_management_read_revision.revision + 1
$$;

CREATE FUNCTION access.realm_management_case_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authority_kind = 'realm' AND NEW.authority_scope_id = 'governance:realm:' || NEW.context THEN
        PERFORM access.advance_realm_management_read_revision(NEW.context);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_management_case_changed AFTER INSERT OR UPDATE OF
    state, generation, decision_head ON access.governance_case
    FOR EACH ROW EXECUTE FUNCTION access.realm_management_case_changed();

CREATE FUNCTION access.realm_management_decision_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authority_kind = 'realm' AND NEW.authority_scope_id IN
        ('governance:realm:' || NEW.context, 'publication:reject:' || NEW.context) THEN
        PERFORM access.advance_realm_management_read_revision(NEW.context);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_management_decision_added AFTER INSERT ON access.moderation_decision
    FOR EACH ROW EXECUTE FUNCTION access.realm_management_decision_added();

-- New Realm reports must use the exact Realm governance gate. NOT VALID leaves
-- legacy rows in place while enforcing the relationship on new writes.
ALTER TABLE access.governance_case ADD CONSTRAINT governance_case_realm_scope
    CHECK (authority_kind <> 'realm' OR authority_scope_id = 'governance:realm:' || context) NOT VALID;

CREATE INDEX governance_case_realm_kind_page ON access.governance_case
    (authority_scope_id, state, kind, opened_at, id) WHERE authority_kind = 'realm';
CREATE INDEX moderation_decision_realm_kind_page ON access.moderation_decision
    (authority_scope_id, kind, decided_at, id) WHERE authority_kind = 'realm';
