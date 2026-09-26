-- Agent control reuses representation: a controller is a principal mandate or
-- an Agent edge for 'agent.control'. This row fixes the Agent's continuity
-- floor and its independent recovery authority. Edges are acyclic, and the
-- recovery subject may not be controlled by the Agent, so a controller cycle is
-- never a recovery path. Recovery is a protected change whose activation adds a
-- new controller; revoked controllers and their past proofs stay as recorded.
CREATE TABLE access.agent_control (
    subject_id text PRIMARY KEY REFERENCES access.authority_subject(id),
    min_controllers smallint NOT NULL DEFAULT 1 CHECK (min_controllers BETWEEN 1 AND 16),
    max_controllers smallint NOT NULL DEFAULT 8 CHECK (max_controllers BETWEEN 1 AND 16),
    recovery_subject text NOT NULL REFERENCES access.authority_subject(id),
    recovery_approvals smallint NOT NULL DEFAULT 1 CHECK (recovery_approvals BETWEEN 1 AND 8),
    recovery_delay interval NOT NULL DEFAULT interval '72 hours'
        CHECK (recovery_delay BETWEEN interval '0' AND interval '30 days'),
    protected_change_id uuid UNIQUE REFERENCES access.protected_change_activation(proposal_id),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (min_controllers <= max_controllers),
    CHECK (recovery_subject <> subject_id)
);
CREATE INDEX agent_control_recovery_subject_fk ON access.agent_control (recovery_subject);
CREATE TRIGGER agent_control_generation_advance BEFORE UPDATE ON access.agent_control
    FOR EACH ROW EXECUTE FUNCTION access.advance_authority_generation();

CREATE INDEX representation_controller_lookup ON access.representation (subject_id, id)
    WHERE active AND action = 'agent.control';
CREATE INDEX representation_edge_controller_lookup ON access.representation_edge
    (represented_subject, id) WHERE active AND action = 'agent.control';
ALTER TABLE access.representation
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
CREATE UNIQUE INDEX representation_protected_change ON access.representation (protected_change_id)
    WHERE protected_change_id IS NOT NULL;
ALTER TABLE access.representation_edge
    ADD COLUMN protected_change_id uuid UNIQUE
        REFERENCES access.protected_change_activation(proposal_id);

-- Controllers counted for continuity: live principal mandates plus live
-- Agent edges. At most 17 rows are read per side.
CREATE FUNCTION access.agent_controller_count(controlled text) RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT (SELECT count(*) FROM (SELECT 1 FROM access.representation r
            JOIN access.principal p ON p.id = r.principal_id
            WHERE r.subject_id = controlled AND r.action = 'agent.control' AND r.active
                AND p.active LIMIT 17) principals)::integer
        + (SELECT count(*) FROM (SELECT 1 FROM access.representation_edge e
            WHERE e.represented_subject = controlled AND e.action = 'agent.control'
                AND e.active AND e.valid_until > clock_timestamp() LIMIT 17) agents)::integer
$$;

-- Configuration changes are protected; the recovery authority must stay
-- outside every control edge path that starts at the controlled Agent.
CREATE FUNCTION access.check_agent_control() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE visited integer; reached boolean;
BEGIN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW.subject_id IS DISTINCT FROM OLD.subject_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at)) THEN
        RAISE EXCEPTION 'agent control identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.protected_change_id IS NOT DISTINCT FROM OLD.protected_change_id THEN
            RAISE EXCEPTION 'agent control policy change requires approval' USING ERRCODE = '23514';
        END IF;
        PERFORM 1 FROM access.protected_change_activation
            WHERE proposal_id = NEW.protected_change_id AND kind = 'agent-control-policy'
                AND target_subject = NEW.subject_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'agent control policy change requires approval' USING ERRCODE = '23514';
        END IF;
    END IF;
    WITH RECURSIVE controlled(subject) AS (
        SELECT NEW.subject_id
        UNION
        SELECT e.represented_subject FROM access.representation_edge e
        JOIN controlled c ON e.representative_subject = c.subject
        WHERE e.active AND e.action = 'agent.control'
    ) SELECT count(*), coalesce(bool_or(subject = NEW.recovery_subject), false)
        INTO visited, reached FROM (SELECT subject FROM controlled LIMIT 257) bounded;
    IF reached THEN
        RAISE EXCEPTION 'recovery authority is controlled by its Agent' USING ERRCODE = '23514';
    ELSIF visited > 256 THEN
        RAISE EXCEPTION 'agent control walk limit' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER agent_control_guard BEFORE INSERT OR UPDATE OR DELETE ON access.agent_control
    FOR EACH ROW EXECUTE FUNCTION access.check_agent_control();

-- Controllers do not expire silently. Once an Agent is under control, a new
-- controller needs an approved controller change, or for a principal, the
-- recovery activated in the same transaction for exactly that replacement.
CREATE FUNCTION access.check_agent_controller() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text; direct boolean; control record; approved record;
BEGIN
    IF NEW.action <> 'agent.control' OR NOT NEW.active OR (TG_OP = 'UPDATE' AND OLD.active) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'a revoked controller cannot be restored' USING ERRCODE = '23514';
    END IF;
    direct := TG_TABLE_NAME = 'representation';
    IF direct THEN
        controlled := NEW.subject_id;
        IF NEW.max_path_edges <> 0 THEN
            RAISE EXCEPTION 'controller mandate must be direct' USING ERRCODE = '23514';
        END IF;
    ELSE
        controlled := NEW.represented_subject;
    END IF;
    IF NEW.valid_until <> 'infinity'::timestamptz THEN
        RAISE EXCEPTION 'controller must be open-ended' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO control FROM access.agent_control WHERE subject_id = controlled FOR UPDATE;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF access.agent_controller_count(controlled) >= control.max_controllers THEN
        RAISE EXCEPTION 'agent controller limit' USING ERRCODE = '54000';
    END IF;
    IF direct THEN
        SELECT a.kind, r.replacement_principal INTO approved
            FROM access.protected_change_activation a
            LEFT JOIN access.agent_recovery r ON r.proposal_id = a.proposal_id
            WHERE a.proposal_id = NEW.protected_change_id AND a.target_subject = controlled
                AND a.kind IN ('agent-controller', 'agent-recovery')
                AND a.activation_txid = txid_current();
        IF FOUND AND (approved.kind = 'agent-controller'
            OR approved.replacement_principal = NEW.principal_id) THEN
            RETURN NEW;
        END IF;
    ELSE
        PERFORM 1 FROM access.protected_change_activation
            WHERE proposal_id = NEW.protected_change_id AND target_subject = controlled
                AND kind = 'agent-controller' AND activation_txid = txid_current();
        IF FOUND THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'new controller requires its approved change' USING ERRCODE = '23514';
END $$;

-- Checked at commit: a controlled Agent keeps its floor unless this
-- transaction activated its recovery, which must still leave a controller.
CREATE FUNCTION access.check_agent_control_continuity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text; control record; live integer; recovering boolean;
BEGIN
    IF TG_TABLE_NAME = 'agent_control' THEN
        controlled := NEW.subject_id;
    ELSIF TG_TABLE_NAME = 'representation' THEN
        IF NEW.action <> 'agent.control' THEN RETURN NULL; END IF;
        controlled := NEW.subject_id;
    ELSE
        IF NEW.action <> 'agent.control' THEN RETURN NULL; END IF;
        controlled := NEW.represented_subject;
    END IF;
    SELECT * INTO control FROM access.agent_control WHERE subject_id = controlled;
    IF NOT FOUND THEN RETURN NULL; END IF;
    live := access.agent_controller_count(controlled);
    SELECT EXISTS (SELECT 1 FROM access.protected_change_activation
        WHERE target_subject = controlled AND kind = 'agent-recovery'
            AND activation_txid = txid_current()) INTO recovering;
    IF live < control.min_controllers AND NOT (recovering AND live >= 1) THEN
        RAISE EXCEPTION 'agent control continuity' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;

-- A recovery request is bound to the Agent's current recovery policy: its
-- approval subject, approval count and waiting period.
CREATE TABLE access.agent_recovery (
    proposal_id uuid PRIMARY KEY,
    kind text NOT NULL DEFAULT 'agent-recovery' CHECK (kind = 'agent-recovery'),
    subject_id text NOT NULL REFERENCES access.agent_control(subject_id),
    reason text NOT NULL CHECK (reason IN ('last-controller-lost', 'controller-compromised')),
    replacement_principal uuid NOT NULL REFERENCES access.principal(id),
    revoke_existing boolean NOT NULL,
    expected_control_generation bigint NOT NULL CHECK (expected_control_generation >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (proposal_id, kind) REFERENCES access.protected_change_proposal(id, kind),
    CHECK (reason <> 'controller-compromised' OR revoke_existing)
);
CREATE INDEX agent_recovery_subject ON access.agent_recovery (subject_id, created_at);
CREATE INDEX agent_recovery_replacement_fk ON access.agent_recovery (replacement_principal);
CREATE TRIGGER agent_recovery_immutable BEFORE UPDATE OR DELETE ON access.agent_recovery
    FOR EACH ROW EXECUTE FUNCTION access.reject_authority_control_mutation();

CREATE FUNCTION access.check_agent_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM access.protected_change_proposal p
        JOIN access.agent_control c ON c.subject_id = NEW.subject_id
        WHERE p.id = NEW.proposal_id AND p.target_subject = NEW.subject_id
            AND p.approval_subject = c.recovery_subject
            AND p.required_approvals = c.recovery_approvals
            AND p.expected_object_generation = c.generation
            AND NEW.expected_control_generation = c.generation
            AND p.not_before >= p.created_at + c.recovery_delay;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'recovery does not match the Agent recovery policy' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER agent_recovery_policy BEFORE INSERT ON access.agent_recovery
    FOR EACH ROW EXECUTE FUNCTION access.check_agent_recovery();

-- A recovery approver is independent of the Agent's current controllers and
-- of the replacement it approves.
CREATE FUNCTION access.check_agent_recovery_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE recovery record;
BEGIN
    SELECT subject_id, replacement_principal INTO recovery FROM access.agent_recovery
        WHERE proposal_id = NEW.proposal_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF recovery.replacement_principal = NEW.approver_principal OR EXISTS (
        SELECT 1 FROM access.representation WHERE principal_id = NEW.approver_principal
            AND subject_id = recovery.subject_id AND action = 'agent.control' AND active) THEN
        RAISE EXCEPTION 'recovery approval is not independent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protected_change_approval_recovery BEFORE INSERT
    ON access.protected_change_approval FOR EACH ROW
    EXECUTE FUNCTION access.check_agent_recovery_approval();

-- Checked at commit: an activated recovery installed its replacement, and a
-- revoking recovery left no other live controller of the Agent.
CREATE FUNCTION access.check_agent_recovery_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE recovery record;
BEGIN
    SELECT * INTO recovery FROM access.agent_recovery WHERE proposal_id = NEW.proposal_id;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM access.representation
            WHERE protected_change_id = NEW.proposal_id AND active
                AND principal_id = recovery.replacement_principal)
        OR (recovery.revoke_existing AND (EXISTS (SELECT 1 FROM access.representation
                WHERE subject_id = recovery.subject_id AND action = 'agent.control' AND active
                    AND protected_change_id IS DISTINCT FROM NEW.proposal_id)
            OR EXISTS (SELECT 1 FROM access.representation_edge
                WHERE represented_subject = recovery.subject_id AND action = 'agent.control'
                    AND active))) THEN
        RAISE EXCEPTION 'agent recovery did not replace its controllers' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER protected_change_activation_agent_recovery AFTER INSERT
    ON access.protected_change_activation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (NEW.kind = 'agent-recovery')
    EXECUTE FUNCTION access.check_agent_recovery_activation();

CREATE TRIGGER representation_agent_controller BEFORE INSERT OR UPDATE ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.check_agent_controller();
CREATE TRIGGER representation_edge_agent_controller BEFORE INSERT OR UPDATE
    ON access.representation_edge FOR EACH ROW
    EXECUTE FUNCTION access.check_agent_controller();
CREATE CONSTRAINT TRIGGER representation_agent_control_continuity AFTER UPDATE OF active
    ON access.representation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION access.check_agent_control_continuity();
CREATE CONSTRAINT TRIGGER representation_edge_agent_control_continuity AFTER UPDATE OF active
    ON access.representation_edge DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION access.check_agent_control_continuity();
CREATE CONSTRAINT TRIGGER agent_control_continuity AFTER INSERT OR UPDATE
    ON access.agent_control DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.check_agent_control_continuity();
