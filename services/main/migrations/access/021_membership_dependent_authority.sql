-- A dependent group grant is usable only by the named membership's member
-- when that Agent is in the group. A role binding depends on its recipient's
-- membership. The dependency is fixed for the row's lifetime.
CREATE FUNCTION access.keep_membership_episode_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.owner_subject IS DISTINCT FROM OLD.owner_subject
        OR NEW.member_subject IS DISTINCT FROM OLD.member_subject
        OR NEW.generation <> OLD.generation + 1
        OR NEW.state = OLD.state THEN
        RAISE EXCEPTION 'membership identity and episode order are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER membership_episode_order BEFORE UPDATE
    ON access.membership FOR EACH ROW
    EXECUTE FUNCTION access.keep_membership_episode_order();

ALTER TABLE access.group_permission_grant
    ADD COLUMN membership_id uuid REFERENCES access.membership(id),
    ADD COLUMN membership_generation bigint,
    ADD CONSTRAINT group_grant_membership_pair CHECK
        ((membership_id IS NULL AND membership_generation IS NULL)
            OR (membership_id IS NOT NULL AND membership_generation >= 1));
CREATE INDEX group_grant_membership_active_lookup
    ON access.group_permission_grant (membership_id, id)
    WHERE active AND membership_id IS NOT NULL;

ALTER TABLE access.role_binding
    ADD COLUMN membership_id uuid REFERENCES access.membership(id),
    ADD COLUMN membership_generation bigint,
    ADD CONSTRAINT role_binding_membership_pair CHECK
        ((membership_id IS NULL AND membership_generation IS NULL)
            OR (membership_id IS NOT NULL AND membership_generation >= 1));
CREATE INDEX role_binding_membership_active_lookup
    ON access.role_binding (membership_id, id)
    WHERE active AND membership_id IS NOT NULL;

CREATE FUNCTION access.check_dependent_authority_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE member text;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.membership_id IS DISTINCT FROM OLD.membership_id
        OR NEW.membership_generation IS DISTINCT FROM OLD.membership_generation) THEN
        RAISE EXCEPTION 'membership dependency is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT NEW.active OR NEW.membership_id IS NULL THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'role_binding' THEN
        member := NEW.recipient_subject;
    END IF;
    PERFORM 1 FROM access.membership
        WHERE id = NEW.membership_id
            AND (member IS NULL OR member_subject = member)
            AND state = 'joined' AND generation = NEW.membership_generation
        FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'inactive or stale membership dependency' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER group_grant_membership_dependency_valid BEFORE INSERT OR UPDATE
    ON access.group_permission_grant FOR EACH ROW
    EXECUTE FUNCTION access.check_dependent_authority_membership();
CREATE TRIGGER role_binding_membership_dependency_valid BEFORE INSERT OR UPDATE
    ON access.role_binding FOR EACH ROW
    EXECUTE FUNCTION access.check_dependent_authority_membership();

-- Match the same immutable episode rule for the earlier direct-grant profile.
CREATE FUNCTION access.keep_grant_membership_dependency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
        OR NEW.membership_generation IS DISTINCT FROM OLD.membership_generation THEN
        RAISE EXCEPTION 'membership dependency is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER grant_membership_dependency_immutable BEFORE UPDATE
    ON access.permission_grant FOR EACH ROW
    EXECUTE FUNCTION access.keep_grant_membership_dependency();
