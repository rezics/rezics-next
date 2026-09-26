-- Protected authority changes are staged as an immutable proposal, approved by
-- distinct principals of the declared approval subject, then activated once in
-- the transaction that applies the effect. The proposal pins the expected scope
-- epoch/object generation and the resulting authority ceiling; the owner rechecks
-- both under the gate before activation. Group reparent impact (016) keeps its
-- existing same-scope profile.
CREATE TABLE access.protected_change_proposal (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('role-revision', 'role-binding', 'group-member',
        'group-parent', 'group-grant', 'automation-install', 'representative-policy',
        'agent-controller', 'agent-control-policy', 'agent-recovery')),
    target_subject text NOT NULL REFERENCES access.authority_subject(id),
    target_object uuid,
    scope_id text REFERENCES access.scope_gate(id),
    expected_authority_epoch bigint CHECK (expected_authority_epoch >= 0),
    expected_object_generation bigint NOT NULL CHECK (expected_object_generation >= 0),
    resulting_ceiling text[] NOT NULL CHECK (cardinality(resulting_ceiling) <= 32),
    staged_change jsonb NOT NULL CHECK (jsonb_typeof(staged_change) = 'object'
        AND octet_length(staged_change::text) <= 16384),
    change_digest text NOT NULL CHECK (change_digest ~ '^[0-9a-f]{64}$'),
    approval_subject text NOT NULL REFERENCES access.authority_subject(id),
    required_approvals smallint NOT NULL CHECK (required_approvals BETWEEN 1 AND 8),
    requested_by uuid NOT NULL REFERENCES access.principal(id),
    requester_subject text REFERENCES access.authority_subject(id),
    not_before timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, kind),
    UNIQUE (id, approval_subject, change_digest),
    CHECK ((scope_id IS NULL) = (expected_authority_epoch IS NULL)),
    CHECK (expires_at > not_before AND expires_at <= created_at + interval '31 days'),
    CHECK ((kind IN ('agent-recovery', 'agent-controller', 'agent-control-policy'))
        = (target_object IS NULL)),
    -- A controlled subject cannot approve its own recovery.
    CHECK (kind <> 'agent-recovery' OR approval_subject <> target_subject)
);
CREATE INDEX protected_change_target ON access.protected_change_proposal
    (target_subject, kind, created_at);
CREATE INDEX protected_change_object ON access.protected_change_proposal (target_object, kind)
    WHERE target_object IS NOT NULL;
CREATE INDEX protected_change_approval_subject_fk ON access.protected_change_proposal
    (approval_subject);
CREATE INDEX protected_change_requested_by_fk ON access.protected_change_proposal (requested_by);
CREATE INDEX protected_change_scope_fk ON access.protected_change_proposal (scope_id)
    WHERE scope_id IS NOT NULL;

-- Each approval names the approver's own current mandate for the approval
-- subject and the exact staged digest.
CREATE TABLE access.protected_change_approval (
    proposal_id uuid NOT NULL,
    approver_principal uuid NOT NULL REFERENCES access.principal(id),
    approver_subject text NOT NULL,
    approver_representation_id uuid NOT NULL,
    approver_representation_generation bigint NOT NULL
        CHECK (approver_representation_generation >= 0),
    approver_representation_action text NOT NULL,
    change_digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (proposal_id, approver_principal),
    FOREIGN KEY (proposal_id, approver_subject, change_digest)
        REFERENCES access.protected_change_proposal(id, approval_subject, change_digest),
    FOREIGN KEY (approver_representation_id, approver_principal, approver_subject,
            approver_representation_action)
        REFERENCES access.representation(id, principal_id, subject_id, action)
);
CREATE INDEX protected_change_approval_representation_fk
    ON access.protected_change_approval (approver_representation_id);
CREATE INDEX protected_change_approval_principal_fk
    ON access.protected_change_approval (approver_principal);

CREATE FUNCTION access.check_protected_change_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM access.protected_change_proposal
        WHERE id = NEW.proposal_id AND requested_by <> NEW.approver_principal
            AND clock_timestamp() < expires_at;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'protected change approval is self-approved or expired'
            USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM access.protected_change_activation WHERE proposal_id = NEW.proposal_id;
    IF FOUND THEN
        RAISE EXCEPTION 'protected change is already activated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- Activation is one-use. Its copied kind/target let effect rows prove which
-- approved change they apply, and its transaction ID marks same-transaction
-- effects such as a recovery below the ordinary controller floor.
CREATE TABLE access.protected_change_activation (
    proposal_id uuid PRIMARY KEY,
    kind text NOT NULL,
    target_subject text NOT NULL REFERENCES access.authority_subject(id),
    target_object uuid,
    activated_by uuid NOT NULL REFERENCES access.principal(id),
    approval_count smallint NOT NULL CHECK (approval_count BETWEEN 1 AND 8),
    result_authority_epoch bigint CHECK (result_authority_epoch >= 0),
    result_object_generation bigint NOT NULL CHECK (result_object_generation >= 0),
    activation_txid bigint NOT NULL DEFAULT txid_current(),
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (proposal_id, kind) REFERENCES access.protected_change_proposal(id, kind)
);
CREATE INDEX protected_change_activation_target ON access.protected_change_activation
    (target_subject, kind, activation_txid);
CREATE INDEX protected_change_activation_activated_by_fk
    ON access.protected_change_activation (activated_by);

CREATE TRIGGER protected_change_approval_independent BEFORE INSERT
    ON access.protected_change_approval FOR EACH ROW
    EXECUTE FUNCTION access.check_protected_change_approval();

CREATE FUNCTION access.check_protected_change_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE proposal record; approvals integer;
BEGIN
    SELECT * INTO proposal FROM access.protected_change_proposal
        WHERE id = NEW.proposal_id FOR SHARE;
    SELECT count(*) INTO approvals FROM access.protected_change_approval
        WHERE proposal_id = NEW.proposal_id;
    IF NEW.target_subject <> proposal.target_subject
        OR NEW.target_object IS DISTINCT FROM proposal.target_object
        OR NEW.approval_count <> approvals OR approvals < proposal.required_approvals
        OR clock_timestamp() < proposal.not_before
        OR clock_timestamp() >= proposal.expires_at
        OR NEW.activation_txid <> txid_current() THEN
        RAISE EXCEPTION 'protected change lacks its approvals or window'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protected_change_activation_complete BEFORE INSERT
    ON access.protected_change_activation FOR EACH ROW
    EXECUTE FUNCTION access.check_protected_change_activation();
CREATE TRIGGER protected_change_proposal_immutable BEFORE UPDATE OR DELETE
    ON access.protected_change_proposal FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();
CREATE TRIGGER protected_change_approval_immutable BEFORE UPDATE OR DELETE
    ON access.protected_change_approval FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();
CREATE TRIGGER protected_change_activation_immutable BEFORE UPDATE OR DELETE
    ON access.protected_change_activation FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();

-- Protection is monotonic in this profile: a protected group (with its
-- descendants) or role family stays protected, with a fixed approval subject.
CREATE TABLE access.protected_set (
    object_kind text NOT NULL CHECK (object_kind IN ('group', 'role-family')),
    object_id uuid NOT NULL,
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    approval_subject text NOT NULL REFERENCES access.authority_subject(id),
    required_approvals smallint NOT NULL CHECK (required_approvals BETWEEN 1 AND 8),
    group_id uuid REFERENCES access.recipient_group(id),
    role_family_id uuid,
    protected_by_principal uuid NOT NULL REFERENCES access.principal(id),
    protected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (object_kind, object_id),
    UNIQUE (group_id),
    UNIQUE (role_family_id),
    FOREIGN KEY (role_family_id, owner_subject) REFERENCES access.role_family(id, owner_subject),
    CHECK ((object_kind = 'group' AND group_id = object_id AND role_family_id IS NULL)
        OR (object_kind = 'role-family' AND role_family_id = object_id AND group_id IS NULL))
);
CREATE INDEX protected_set_owner_fk ON access.protected_set (owner_subject);
CREATE INDEX protected_set_approval_subject_fk ON access.protected_set (approval_subject);
CREATE TRIGGER protected_set_immutable BEFORE UPDATE OR DELETE
    ON access.protected_set FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();

-- Protection and effect writes serialize on one anchor row: the group's scope
-- gate or the role family. Effect guards lock it before reading protection, so
-- a concurrent protection commit is never missed. The lock is exclusive because
-- group writes already update the gate after insert; a shared lock would
-- deadlock two such writers.
CREATE FUNCTION access.lock_protection_anchor(anchor_kind text, anchor_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF anchor_kind = 'group' THEN
        PERFORM 1 FROM access.scope_gate g JOIN access.recipient_group r ON r.scope_id = g.id
            WHERE r.id = anchor_id FOR UPDATE OF g;
    ELSE
        PERFORM 1 FROM access.role_family WHERE id = anchor_id FOR UPDATE;
    END IF;
END $$;
CREATE FUNCTION access.lock_protected_set() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM access.lock_protection_anchor(NEW.object_kind, NEW.object_id);
    RETURN NEW;
END $$;
CREATE TRIGGER protected_set_anchor BEFORE INSERT ON access.protected_set
    FOR EACH ROW EXECUTE FUNCTION access.lock_protected_set();

-- A privileged installation lets a workload principal represent the owner for
-- Access or Agent-control actions; it needs an approved protected change.
CREATE TABLE access.automation_installation (
    id uuid PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    workload_principal uuid NOT NULL REFERENCES access.principal(id),
    actions text[] NOT NULL CHECK (cardinality(actions) BETWEEN 1 AND 32
        AND array_position(actions, NULL) IS NULL),
    privileged boolean NOT NULL,
    protected_change_id uuid UNIQUE REFERENCES access.protected_change_activation(proposal_id),
    installed_by_principal uuid NOT NULL REFERENCES access.principal(id),
    valid_until timestamptz NOT NULL,
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, workload_principal, owner_subject),
    CHECK (NOT privileged OR protected_change_id IS NOT NULL),
    CHECK (valid_until > created_at)
);
CREATE INDEX automation_installation_owner ON access.automation_installation (owner_subject, id);
CREATE INDEX automation_installation_workload ON access.automation_installation
    (workload_principal, id) WHERE active;
CREATE INDEX automation_installation_installed_by_fk
    ON access.automation_installation (installed_by_principal);
CREATE TRIGGER automation_installation_generation_advance BEFORE UPDATE
    ON access.automation_installation FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();

-- A mandate created by an installation stays inside its owner and actions.
ALTER TABLE access.representation
    ADD COLUMN automation_installation_id uuid,
    ADD CONSTRAINT representation_automation_installation
        FOREIGN KEY (automation_installation_id, principal_id, subject_id)
        REFERENCES access.automation_installation(id, workload_principal, owner_subject);
-- One live mandate per installed action bounds the revocation below to 32 rows.
CREATE UNIQUE INDEX representation_automation_action ON access.representation
    (automation_installation_id, action) WHERE active AND automation_installation_id IS NOT NULL;
CREATE INDEX representation_automation_installation_fk ON access.representation
    (automation_installation_id) WHERE automation_installation_id IS NOT NULL;

-- Effect rows that widen a protected set name their activation. A missing or
-- mismatched activation fails closed, including for owner paths that predate
-- protection; unprotected objects are unchanged.
ALTER TABLE access.group_member
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
ALTER TABLE access.private_group_member
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
ALTER TABLE access.recipient_group
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
ALTER TABLE access.group_permission_grant
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
ALTER TABLE access.role_revision
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
ALTER TABLE access.role_binding
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
ALTER TABLE access.private_role_binding
    ADD COLUMN protected_change_id uuid REFERENCES access.protected_change_activation(proposal_id);
CREATE UNIQUE INDEX group_member_protected_change ON access.group_member (protected_change_id)
    WHERE protected_change_id IS NOT NULL;
CREATE UNIQUE INDEX private_group_member_protected_change
    ON access.private_group_member (protected_change_id) WHERE protected_change_id IS NOT NULL;
CREATE INDEX recipient_group_protected_change ON access.recipient_group (protected_change_id)
    WHERE protected_change_id IS NOT NULL;
CREATE UNIQUE INDEX group_grant_protected_change
    ON access.group_permission_grant (protected_change_id) WHERE protected_change_id IS NOT NULL;
CREATE UNIQUE INDEX role_revision_protected_change ON access.role_revision (protected_change_id)
    WHERE protected_change_id IS NOT NULL;
CREATE UNIQUE INDEX role_binding_protected_change ON access.role_binding (protected_change_id)
    WHERE protected_change_id IS NOT NULL;
CREATE UNIQUE INDEX private_role_binding_protected_change
    ON access.private_role_binding (protected_change_id) WHERE protected_change_id IS NOT NULL;

CREATE FUNCTION access.require_protected_change(change_id uuid, change_kind text,
    change_object uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM access.protected_change_activation
        WHERE proposal_id = change_id AND kind = change_kind
            AND target_object = change_object;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'protected authority change requires its approved activation'
            USING ERRCODE = '23514';
    END IF;
END $$;

-- The subtree walk follows at most 33 ancestor and 256 descendant groups,
-- matching the admitted group profile; a longer walk is unavailable.
CREATE FUNCTION access.group_path_is_protected(start_group uuid, descendants boolean)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE found_protected boolean; visited integer;
BEGIN
    PERFORM access.lock_protection_anchor('group', start_group);
    IF NOT EXISTS (SELECT 1 FROM access.protected_set WHERE object_kind = 'group') THEN
        RETURN false;
    END IF;
    IF descendants THEN
        WITH RECURSIVE tree(id) AS (
            SELECT start_group
            UNION
            SELECT g.id FROM access.recipient_group g JOIN tree t ON g.parent_id = t.id
        ) SELECT count(*), coalesce(bool_or(p.group_id IS NOT NULL), false)
            INTO visited, found_protected
            FROM (SELECT id FROM tree LIMIT 257) bounded
            LEFT JOIN access.protected_set p ON p.group_id = bounded.id;
    ELSE
        WITH RECURSIVE tree(id, parent_id) AS (
            SELECT id, parent_id FROM access.recipient_group WHERE id = start_group
            UNION
            SELECT g.id, g.parent_id FROM access.recipient_group g
            JOIN tree t ON g.id = t.parent_id
        ) SELECT count(*), coalesce(bool_or(p.group_id IS NOT NULL), false)
            INTO visited, found_protected
            FROM (SELECT id FROM tree LIMIT 34) bounded
            LEFT JOIN access.protected_set p ON p.group_id = bounded.id;
        IF visited > 33 THEN visited := 257; END IF;
    END IF;
    IF visited > 256 THEN
        RAISE EXCEPTION 'protected group walk limit' USING ERRCODE = '54000';
    END IF;
    RETURN found_protected;
END $$;

CREATE FUNCTION access.guard_protected_set_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE family uuid; activating boolean;
BEGIN
    activating := TG_OP = 'INSERT' OR (to_jsonb(NEW) ? 'active'
        AND (to_jsonb(NEW)->>'active')::boolean AND NOT (to_jsonb(OLD)->>'active')::boolean);
    IF TG_TABLE_NAME IN ('group_member', 'private_group_member') THEN
        IF activating AND access.group_path_is_protected(NEW.group_id, false) THEN
            IF TG_OP = 'UPDATE'
                AND NEW.protected_change_id IS NOT DISTINCT FROM OLD.protected_change_id THEN
                RAISE EXCEPTION 'protected authority change requires its approved activation'
                    USING ERRCODE = '23514';
            END IF;
            PERFORM access.require_protected_change(NEW.protected_change_id, 'group-member',
                NEW.group_id);
        END IF;
    ELSIF TG_TABLE_NAME = 'recipient_group' THEN
        -- Moving a protected group, a group above a protected descendant, or a
        -- group into or out of a protected set changes that set's authority.
        IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id
            AND (access.group_path_is_protected(NEW.id, true)
                OR access.group_path_is_protected(NEW.id, false)
                OR (NEW.parent_id IS NOT NULL
                    AND access.group_path_is_protected(NEW.parent_id, false))) THEN
            IF NEW.protected_change_id IS NOT DISTINCT FROM OLD.protected_change_id THEN
                RAISE EXCEPTION 'protected authority change requires its approved activation'
                    USING ERRCODE = '23514';
            END IF;
            PERFORM access.require_protected_change(NEW.protected_change_id, 'group-parent',
                NEW.id);
        END IF;
    ELSIF TG_TABLE_NAME = 'group_permission_grant' THEN
        IF activating AND access.group_path_is_protected(NEW.group_id, true) THEN
            IF TG_OP = 'UPDATE'
                AND NEW.protected_change_id IS NOT DISTINCT FROM OLD.protected_change_id THEN
                RAISE EXCEPTION 'protected authority change requires its approved activation'
                    USING ERRCODE = '23514';
            END IF;
            PERFORM access.require_protected_change(NEW.protected_change_id, 'group-grant',
                NEW.group_id);
        END IF;
    ELSE
        family := NEW.family_id;
        IF activating THEN PERFORM access.lock_protection_anchor('role-family', family); END IF;
        IF activating
            AND EXISTS (SELECT 1 FROM access.protected_set WHERE role_family_id = family) THEN
            IF TG_OP = 'UPDATE'
                AND NEW.protected_change_id IS NOT DISTINCT FROM OLD.protected_change_id THEN
                RAISE EXCEPTION 'protected authority change requires its approved activation'
                    USING ERRCODE = '23514';
            END IF;
            PERFORM access.require_protected_change(NEW.protected_change_id,
                CASE WHEN TG_TABLE_NAME = 'role_revision' THEN 'role-revision'
                    ELSE 'role-binding' END, family);
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER group_member_protected_set BEFORE INSERT OR UPDATE ON access.group_member
    FOR EACH ROW EXECUTE FUNCTION access.guard_protected_set_change();
CREATE TRIGGER private_group_member_protected_set BEFORE INSERT OR UPDATE
    ON access.private_group_member FOR EACH ROW
    EXECUTE FUNCTION access.guard_protected_set_change();
CREATE TRIGGER recipient_group_protected_set BEFORE UPDATE OF parent_id ON access.recipient_group
    FOR EACH ROW EXECUTE FUNCTION access.guard_protected_set_change();
CREATE TRIGGER group_grant_protected_set BEFORE INSERT OR UPDATE
    ON access.group_permission_grant FOR EACH ROW
    EXECUTE FUNCTION access.guard_protected_set_change();
CREATE TRIGGER role_revision_protected_set BEFORE INSERT ON access.role_revision
    FOR EACH ROW EXECUTE FUNCTION access.guard_protected_set_change();
CREATE TRIGGER role_binding_protected_set BEFORE INSERT OR UPDATE ON access.role_binding
    FOR EACH ROW EXECUTE FUNCTION access.guard_protected_set_change();
CREATE TRIGGER private_role_binding_protected_set BEFORE INSERT OR UPDATE
    ON access.private_role_binding FOR EACH ROW
    EXECUTE FUNCTION access.guard_protected_set_change();

CREATE FUNCTION access.guard_automation_installation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'automation_installation' THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'automation installation cannot be erased' USING ERRCODE = '23514';
        ELSIF TG_OP = 'UPDATE' THEN
            IF (to_jsonb(NEW) - 'active' - 'generation')
                    <> (to_jsonb(OLD) - 'active' - 'generation')
                OR (NOT OLD.active AND NEW.active) THEN
                RAISE EXCEPTION 'automation installation is immutable; only revoke is allowed'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END IF;
        IF NOT NEW.active OR NEW.privileged <> EXISTS (SELECT 1 FROM unnest(NEW.actions) a
            WHERE a LIKE 'access.%' OR a LIKE 'agent.%') THEN
            RAISE EXCEPTION 'automation privilege classification is wrong' USING ERRCODE = '23514';
        END IF;
        IF NEW.privileged THEN
            PERFORM access.require_protected_change(NEW.protected_change_id,
                'automation-install', NEW.id);
        END IF;
    ELSIF NEW.automation_installation_id IS NOT NULL AND NEW.active THEN
        PERFORM 1 FROM access.automation_installation
            WHERE id = NEW.automation_installation_id AND active
                AND NEW.action = ANY(actions) AND NEW.valid_until <= valid_until
            FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'mandate exceeds its automation installation' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
-- Revoking an installation fences its mandates in the same transaction.
CREATE FUNCTION access.revoke_automation_mandates() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE access.representation SET active = false
    WHERE automation_installation_id = NEW.id AND active;
    RETURN NULL;
END $$;
CREATE TRIGGER automation_installation_revocation AFTER UPDATE OF active
    ON access.automation_installation FOR EACH ROW
    WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION access.revoke_automation_mandates();
CREATE TRIGGER automation_installation_guard BEFORE INSERT OR UPDATE OR DELETE
    ON access.automation_installation FOR EACH ROW
    EXECUTE FUNCTION access.guard_automation_installation();
CREATE TRIGGER representation_automation_guard BEFORE INSERT OR UPDATE
    ON access.representation FOR EACH ROW
    EXECUTE FUNCTION access.guard_automation_installation();
