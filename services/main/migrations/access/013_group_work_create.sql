-- First private same-scope group profile: Agent members and work.create only.
-- The scope row serializes all topology and roster changes with decisions.
CREATE TABLE access.recipient_group (
    id uuid PRIMARY KEY,
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    parent_id uuid,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    UNIQUE (id, scope_id),
    FOREIGN KEY (parent_id, scope_id) REFERENCES access.recipient_group(id, scope_id)
);
CREATE INDEX recipient_group_parent ON access.recipient_group(parent_id);

CREATE TABLE access.group_member (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES access.recipient_group(id),
    agent_subject text NOT NULL REFERENCES access.authority_subject(id),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    UNIQUE (group_id, agent_subject)
);
CREATE INDEX group_member_agent ON access.group_member(agent_subject, group_id) WHERE active;

CREATE TABLE access.group_permission_grant (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES access.recipient_group(id),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    action text NOT NULL CHECK (action = 'work.create'),
    active boolean NOT NULL DEFAULT true,
    valid_until timestamptz NOT NULL,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    FOREIGN KEY (group_id, scope_id) REFERENCES access.recipient_group(id, scope_id)
);
CREATE INDEX group_grant_lookup ON access.group_permission_grant
    (group_id, scope_id, action, valid_until) WHERE active;

-- A saved group proof is checked again at claim. Every group mutation changes
-- this scope-wide generation, including revocation and a no-longer-valid path.
ALTER TABLE access.scope_gate ADD COLUMN group_generation bigint NOT NULL DEFAULT 0
    CHECK (group_generation >= 0);
ALTER TABLE access.admission ADD COLUMN group_member_id uuid REFERENCES access.group_member(id);
ALTER TABLE access.admission ADD COLUMN group_grant_id uuid REFERENCES access.group_permission_grant(id);
ALTER TABLE access.admission ADD COLUMN group_generation bigint;
ALTER TABLE access.admission ADD CONSTRAINT group_admission_proof CHECK (
    (group_member_id IS NULL AND group_grant_id IS NULL AND group_generation IS NULL)
    OR (authority_path = 'represented-agent' AND action = 'work.create'
        AND scope_id = 'work:create:root' AND group_member_id IS NOT NULL
        AND group_grant_id IS NOT NULL AND group_generation IS NOT NULL)
);

CREATE FUNCTION access.guard_group_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cyclic boolean;
BEGIN
    -- Serializes even raw owner writes; the application locks this gate first.
    PERFORM 1 FROM access.scope_gate WHERE id = NEW.scope_id FOR UPDATE;
    IF NEW.parent_id IS NOT NULL THEN
        WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM access.recipient_group WHERE id = NEW.parent_id
            UNION
            SELECT p.id, p.parent_id FROM access.recipient_group p
            JOIN ancestors a ON p.id = a.parent_id
        ) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cyclic;
        IF cyclic THEN RAISE EXCEPTION 'recipient group cycle' USING ERRCODE = '23514'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER recipient_group_parent_guard BEFORE INSERT OR UPDATE OF parent_id, scope_id
    ON access.recipient_group FOR EACH ROW EXECUTE FUNCTION access.guard_group_parent();

CREATE FUNCTION access.bump_group_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_scope text;
BEGIN
    IF TG_TABLE_NAME = 'recipient_group' THEN
        IF TG_OP = 'DELETE' THEN target_scope := OLD.scope_id;
        ELSE target_scope := NEW.scope_id; END IF;
    ELSIF TG_TABLE_NAME = 'group_permission_grant' THEN
        IF TG_OP = 'DELETE' THEN target_scope := OLD.scope_id;
        ELSE target_scope := NEW.scope_id; END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            SELECT scope_id INTO target_scope FROM access.recipient_group WHERE id = OLD.group_id;
        ELSE
            SELECT scope_id INTO target_scope FROM access.recipient_group WHERE id = NEW.group_id;
        END IF;
    END IF;
    UPDATE access.scope_gate SET group_generation = group_generation + 1
    WHERE id = target_scope;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER recipient_group_generation AFTER INSERT OR UPDATE OR DELETE
    ON access.recipient_group FOR EACH ROW EXECUTE FUNCTION access.bump_group_generation();
CREATE TRIGGER group_member_generation AFTER INSERT OR UPDATE OR DELETE
    ON access.group_member FOR EACH ROW EXECUTE FUNCTION access.bump_group_generation();
CREATE TRIGGER group_grant_generation AFTER INSERT OR UPDATE OR DELETE
    ON access.group_permission_grant FOR EACH ROW EXECUTE FUNCTION access.bump_group_generation();
