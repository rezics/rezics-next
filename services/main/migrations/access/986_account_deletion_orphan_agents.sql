-- An explicit deletion choice leaves non-Person Agents under platform care.
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
