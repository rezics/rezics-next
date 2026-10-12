-- An explicit deletion choice leaves non-Person Agents under platform care.
-- An edge can act only while its representing Agent's authority is active.
-- Keep the principal-mandate semantics and the 17-row bound per side.
CREATE OR REPLACE FUNCTION access.agent_controller_count(controlled text) RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT (SELECT count(*) FROM (SELECT 1 FROM access.representation r
            JOIN access.principal p ON p.id = r.principal_id
            WHERE r.subject_id = controlled AND r.action = 'agent.control' AND r.active
                AND p.active LIMIT 17) principals)::integer
        + (SELECT count(*) FROM (SELECT 1 FROM access.representation_edge e
            JOIN access.authority_subject s ON s.id = e.representative_subject AND s.active
            WHERE e.represented_subject = controlled AND e.action = 'agent.control'
                AND e.active AND e.valid_until > clock_timestamp() LIMIT 17) agents)::integer
$$;

CREATE TABLE access.account_deletion_orphan_agent (
    agent_id text PRIMARY KEY REFERENCES access.authority_subject(id),
    deleted_principal_id uuid NOT NULL REFERENCES access.principal(id),
    deleted_at timestamptz NOT NULL,
    operation_id text NOT NULL
);
CREATE INDEX account_deletion_orphan_agent_principal
    ON access.account_deletion_orphan_agent (deleted_principal_id, agent_id);
CREATE INDEX account_deletion_orphan_agent_operation
    ON access.account_deletion_orphan_agent (operation_id);

-- One owner predicate for command checks and the deferred database guard.
-- Inactive authority is ended; intentional ownerlessness lasts until an
-- approved controller change or recovery attaches a replacement controller.
CREATE FUNCTION access.agent_control_continuity_allowed(controlled text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    WITH controllers AS MATERIALIZED (
        SELECT access.agent_controller_count(controlled) AS live)
    SELECT EXISTS (SELECT 1 FROM access.authority_subject WHERE id = controlled AND NOT active)
        OR EXISTS (SELECT 1 FROM access.account_deletion_orphan_agent WHERE agent_id = controlled)
        OR live >= coalesce((SELECT min_controllers FROM access.agent_control WHERE subject_id = controlled), 1)
        OR (live >= 1 AND EXISTS (SELECT 1 FROM access.protected_change_activation
            WHERE target_subject = controlled AND kind = 'agent-recovery'
                AND activation_txid = txid_current())) FROM controllers
$$;

CREATE OR REPLACE FUNCTION access.check_agent_control_continuity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text;
BEGIN
    IF TG_TABLE_NAME = 'agent_control' THEN controlled := NEW.subject_id;
    ELSIF TG_TABLE_NAME = 'representation' THEN
        IF NEW.action <> 'agent.control' THEN RETURN NULL; END IF;
        controlled := NEW.subject_id;
    ELSE
        IF NEW.action <> 'agent.control' THEN RETURN NULL; END IF;
        controlled := NEW.represented_subject;
    END IF;
    IF NOT access.agent_control_continuity_allowed(controlled) THEN
        RAISE EXCEPTION 'agent control continuity' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION access.reattach_account_deletion_orphan_agent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text;
BEGIN
    IF NEW.action <> 'agent.control' OR NOT NEW.active THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'representation' THEN controlled := NEW.subject_id;
    ELSE controlled := NEW.represented_subject; END IF;
    IF EXISTS (SELECT 1 FROM access.protected_change_activation
        WHERE proposal_id = NEW.protected_change_id AND target_subject = controlled
            AND kind IN ('agent-controller', 'agent-recovery') AND activation_txid = txid_current()) THEN
        DELETE FROM access.account_deletion_orphan_agent WHERE agent_id = controlled;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_reattach_account_deletion_orphan AFTER INSERT ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.reattach_account_deletion_orphan_agent();
CREATE TRIGGER representation_edge_reattach_account_deletion_orphan AFTER INSERT ON access.representation_edge
    FOR EACH ROW EXECUTE FUNCTION access.reattach_account_deletion_orphan_agent();

-- A large erasure fences its principal before applying bounded Agent effects.
-- Retain the original operation and inventory so a retry resumes after a crash.
CREATE TABLE access.account_deletion_progress (
    operation_id text PRIMARY KEY,
    principal_id uuid NOT NULL UNIQUE REFERENCES access.principal(id),
    completed boolean NOT NULL DEFAULT false
);
CREATE TABLE access.account_deletion_progress_agent (
    operation_id text NOT NULL REFERENCES access.account_deletion_progress(operation_id),
    agent_id text NOT NULL REFERENCES access.authority_subject(id),
    effect text NOT NULL CHECK (effect IN ('keep', 'end', 'orphan')),
    completed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (operation_id, agent_id)
);
CREATE INDEX account_deletion_progress_agent_pending
    ON access.account_deletion_progress_agent (operation_id, agent_id) WHERE NOT completed;
CREATE INDEX account_deletion_progress_agent_subject
    ON access.account_deletion_progress_agent (agent_id, operation_id);

-- Stabilize only an in-progress operation's controller inventory between steps.
-- This is a temporary fence, never an exception to ordinary continuity. New
-- controllers and recovery can attach once the deletion's final step commits.
CREATE FUNCTION access.fence_account_deletion_control() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE subjects text[];
BEGIN
    IF TG_TABLE_NAME = 'principal' THEN
        IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
        IF EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
            JOIN access.account_deletion_progress p USING (operation_id)
            JOIN access.representation r ON r.subject_id = a.agent_id
            WHERE NOT p.completed AND p.principal_id <> NEW.id
                AND r.principal_id = NEW.id AND r.action = 'agent.control' AND r.active) THEN
            RAISE EXCEPTION 'Account deletion control inventory is fenced' USING ERRCODE = '54000';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'agent_control' THEN subjects := ARRAY[NEW.subject_id];
    ELSIF TG_TABLE_NAME = 'representation' THEN
        IF NEW.action <> 'agent.control' THEN RETURN NEW; END IF;
        subjects := ARRAY[NEW.subject_id];
    ELSE
        IF NEW.action <> 'agent.control' THEN RETURN NEW; END IF;
        subjects := ARRAY[NEW.representative_subject, NEW.represented_subject];
    END IF;
    -- Same ordering as the control owner and deletion: topology before Agent.
    PERFORM 1 FROM access.scope_gate WHERE id = 'access:representation-topology' FOR UPDATE;
    IF EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
        JOIN access.account_deletion_progress p USING (operation_id)
        WHERE a.agent_id = ANY(subjects) AND NOT p.completed) THEN
        RAISE EXCEPTION 'Account deletion control inventory is fenced' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER principal_account_deletion_control_fence BEFORE UPDATE OF active ON access.principal
    FOR EACH ROW EXECUTE FUNCTION access.fence_account_deletion_control();
CREATE TRIGGER representation_account_deletion_control_fence BEFORE INSERT OR UPDATE ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.fence_account_deletion_control();
CREATE TRIGGER representation_edge_account_deletion_control_fence BEFORE INSERT OR UPDATE ON access.representation_edge
    FOR EACH ROW EXECUTE FUNCTION access.fence_account_deletion_control();
CREATE TRIGGER agent_control_account_deletion_control_fence BEFORE INSERT OR UPDATE ON access.agent_control
    FOR EACH ROW EXECUTE FUNCTION access.fence_account_deletion_control();
