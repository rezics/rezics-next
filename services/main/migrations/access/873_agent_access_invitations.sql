-- A new Agent has a controller before it has a recovery policy. Serialize raw
-- controller writes on the same gate as product writes, including the default
-- floor; a deferred count alone is insufficient for concurrent departures.
CREATE OR REPLACE FUNCTION access.check_agent_control_continuity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text; floor integer; live integer; recovering boolean;
BEGIN
    IF TG_TABLE_NAME = 'agent_control' THEN controlled := NEW.subject_id;
    ELSIF TG_TABLE_NAME = 'representation' THEN
        IF NEW.action <> 'agent.control' THEN RETURN NULL; END IF;
        controlled := NEW.subject_id;
    ELSE
        IF NEW.action <> 'agent.control' THEN RETURN NULL; END IF;
        controlled := NEW.represented_subject;
    END IF;
    SELECT min_controllers INTO floor FROM access.agent_control WHERE subject_id = controlled;
    floor := coalesce(floor, 1);
    live := access.agent_controller_count(controlled);
    SELECT EXISTS (SELECT 1 FROM access.protected_change_activation
        WHERE target_subject = controlled AND kind = 'agent-recovery'
            AND activation_txid = txid_current()) INTO recovering;
    IF live < floor AND NOT (recovering AND live >= 1) THEN
        RAISE EXCEPTION 'agent control continuity' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION access.lock_agent_controller_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.action = 'agent.control' THEN
        PERFORM 1 FROM access.scope_gate WHERE id = 'work:create:root' FOR UPDATE;
        PERFORM 1 FROM access.scope_gate WHERE id = 'access:representation-topology' FOR UPDATE;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_controller_lock BEFORE UPDATE OF active ON access.representation
    FOR EACH ROW WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION access.lock_agent_controller_change();
CREATE TRIGGER representation_edge_controller_lock BEFORE UPDATE OF active ON access.representation_edge
    FOR EACH ROW WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION access.lock_agent_controller_change();

CREATE FUNCTION access.fence_agent_controller_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text; scopes text[];
BEGIN
    IF TG_TABLE_NAME = 'representation' THEN controlled := NEW.subject_id;
    ELSE controlled := NEW.represented_subject; END IF;
    SELECT array_agg(scope_id ORDER BY scope_id) INTO scopes FROM (
        SELECT DISTINCT scope_id FROM access.permission_grant WHERE recipient_subject = controlled LIMIT 257
    ) owned;
    IF cardinality(scopes) > 256 THEN RAISE EXCEPTION 'controller scope fence limit' USING ERRCODE = '54000'; END IF;
    PERFORM 1 FROM access.scope_gate WHERE id = ANY(coalesce(scopes,ARRAY[]::text[])) ORDER BY id FOR UPDATE;
    UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = 'work:create:root' OR id = ANY(coalesce(scopes,ARRAY[]::text[]));
    RETURN NULL;
END $$;
CREATE TRIGGER representation_controller_work_fence AFTER UPDATE OF active ON access.representation
    FOR EACH ROW WHEN (OLD.active AND NOT NEW.active AND NEW.action = 'agent.control')
    EXECUTE FUNCTION access.fence_agent_controller_work();
CREATE TRIGGER representation_edge_controller_work_fence AFTER UPDATE OF active ON access.representation_edge
    FOR EACH ROW WHEN (OLD.active AND NOT NEW.active AND NEW.action = 'agent.control')
    EXECUTE FUNCTION access.fence_agent_controller_work();

ALTER TABLE access.agent_invitation
    ADD COLUMN offer text NOT NULL DEFAULT 'manage' CHECK (offer IN ('control','represent','manage')),
    ADD COLUMN actions text[] NOT NULL DEFAULT ARRAY['work.create']
        CHECK (cardinality(actions) BETWEEN 1 AND 16 AND array_position(actions,NULL) IS NULL),
    ALTER COLUMN ceiling_grant_id DROP NOT NULL,
    ALTER COLUMN ceiling_grant_generation DROP NOT NULL,
    ADD CONSTRAINT invitation_primary_action CHECK (action = actions[1]),
    ADD CONSTRAINT invitation_control_ceiling CHECK (
        (offer = 'control' AND action = 'agent.control' AND actions = ARRAY['agent.control']
            AND issuer_representation_action = 'agent.control'
            AND ceiling_grant_id IS NULL AND ceiling_grant_generation IS NULL
            AND grant_valid_until = 'infinity'::timestamptz)
        OR (offer <> 'control' AND ceiling_grant_id IS NOT NULL AND ceiling_grant_generation IS NOT NULL));

-- An edge is still a representation edge. The invitation only supplies the
-- exact issuer/recipient/action/expiry basis, never a management capability.
ALTER TABLE access.representation_edge
    ADD COLUMN invitation_id uuid REFERENCES access.agent_invitation(id),
    DROP CONSTRAINT representation_edge_ceiling_action_check,
    ADD CONSTRAINT representation_edge_ceiling_action_check CHECK (
        ceiling_action LIKE 'access.representation.assign.%' OR invitation_id IS NOT NULL);
CREATE INDEX representation_edge_invitation ON access.representation_edge (invitation_id,id)
    WHERE invitation_id IS NOT NULL;

ALTER TABLE access.agent_invitation_acceptance
    ALTER COLUMN grant_id DROP NOT NULL,
    ADD COLUMN edge_id uuid UNIQUE REFERENCES access.representation_edge(id),
    ADD COLUMN controller_representation_id uuid UNIQUE REFERENCES access.representation(id),
    ADD CONSTRAINT invitation_one_authority CHECK (
        num_nonnulls(grant_id,edge_id,controller_representation_id) = 1);
-- PostgreSQL shortens generated constraint names by truncating both the table
-- and column components. Locate this one-column CHECK by its definition.
DO $$ DECLARE constraint_name text;
BEGIN
    SELECT conname INTO STRICT constraint_name FROM pg_constraint
        WHERE conrelid = 'access.agent_invitation_acceptance'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%acceptor_representation_action%';
    EXECUTE format('ALTER TABLE access.agent_invitation_acceptance DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE access.agent_invitation_acceptance ADD CONSTRAINT invitation_acceptor_action CHECK (
    acceptor_representation_action IN ('access.invitation.accept','agent.control'));

CREATE OR REPLACE FUNCTION access.check_invitation_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE invitation record;
BEGIN
    SELECT * INTO invitation FROM access.agent_invitation WHERE id = NEW.invitation_id;
    IF invitation.offer <> 'manage' OR NEW.lifetime <> 'institutional'
        OR (NEW.issuer_subject, NEW.recipient_subject, NEW.scope_id,
            NEW.assigned_by_principal, NEW.issuer_representation_id,
            NEW.issuer_representation_generation, NEW.issuer_representation_action)
        IS DISTINCT FROM (invitation.issuer_subject, invitation.recipient_subject,
            invitation.scope_id, invitation.issued_by_principal,
            invitation.issuer_representation_id, invitation.issuer_representation_generation,
            invitation.issuer_representation_action)
        OR NOT (NEW.action = ANY(invitation.actions))
        OR (invitation.issuer_lifetime = 'operator-dependent' AND NEW.action = invitation.action
            AND (NEW.ceiling_grant_id, NEW.ceiling_grant_generation)
                IS DISTINCT FROM (invitation.ceiling_grant_id, invitation.ceiling_grant_generation)) THEN
        RAISE EXCEPTION 'invitation grant differs from its offer' USING ERRCODE = '23514';
    END IF;
    -- Product grants use the issuer's own resource permission as their ceiling.
    -- Legacy invitations keep their separately assigned ceiling.
    IF invitation.issuer_representation_action = 'agent.control'
        AND (NEW.ceiling_scope_id <> invitation.scope_id OR NEW.ceiling_action <> NEW.action) THEN
        RAISE EXCEPTION 'invitation ceiling is outside the owned resource' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION access.check_invitation_edge() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE invitation record;
BEGIN
    SELECT * INTO invitation FROM access.agent_invitation WHERE id = NEW.invitation_id;
    IF invitation.offer <> 'represent'
        OR NEW.represented_subject <> invitation.issuer_subject
        OR NEW.representative_subject <> invitation.recipient_subject
        OR NOT (NEW.action = ANY(invitation.actions))
        OR NEW.valid_until <> invitation.grant_valid_until
        OR NEW.max_path_edges <> 1 OR NEW.resource_subject IS NOT NULL
        OR (NEW.assigned_by_principal,NEW.issuer_representation_id,NEW.issuer_representation_generation,
            NEW.issuer_representation_action,NEW.ceiling_scope_id,NEW.ceiling_action)
        IS DISTINCT FROM (invitation.issued_by_principal,invitation.issuer_representation_id,
            invitation.issuer_representation_generation,invitation.issuer_representation_action,
            invitation.scope_id,NEW.action)
        OR NOT EXISTS (SELECT 1 FROM access.permission_grant g WHERE g.id = NEW.ceiling_grant_id
            AND g.recipient_subject = invitation.issuer_subject AND g.active
            AND g.generation = NEW.ceiling_grant_generation AND g.valid_until >= NEW.valid_until) THEN
        RAISE EXCEPTION 'invitation edge differs from its offer or ceiling' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_edge_invitation_basis BEFORE INSERT ON access.representation_edge
    FOR EACH ROW WHEN (NEW.invitation_id IS NOT NULL) EXECUTE FUNCTION access.check_invitation_edge();

CREATE OR REPLACE FUNCTION access.check_agent_invitation_outcome() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE invitation record;
BEGIN
    SELECT * INTO invitation FROM access.agent_invitation WHERE id = NEW.invitation_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM access.agent_invitation_revocation WHERE invitation_id = NEW.invitation_id)
        OR (TG_TABLE_NAME = 'agent_invitation_acceptance' AND EXISTS (
            SELECT 1 FROM access.agent_invitation_acceptance WHERE invitation_id = NEW.invitation_id)) THEN
        RAISE EXCEPTION 'invitation already has an outcome' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'agent_invitation_revocation' THEN
        IF EXISTS (SELECT 1 FROM access.permission_grant g JOIN access.grant_lineage l ON l.grant_id = g.id
                WHERE l.invitation_id = NEW.invitation_id AND g.active)
            OR EXISTS (SELECT 1 FROM access.representation_edge WHERE invitation_id = NEW.invitation_id AND active)
            OR EXISTS (SELECT 1 FROM access.agent_invitation_acceptance a
                JOIN access.representation r ON r.id = a.controller_representation_id
                WHERE a.invitation_id = NEW.invitation_id AND r.active) THEN
            RAISE EXCEPTION 'accepted invitation authority must be revoked' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF clock_timestamp() >= invitation.expires_at THEN
        RAISE EXCEPTION 'invitation expired' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM access.authority_subject WHERE id = invitation.recipient_subject
        AND active AND generation = NEW.recipient_generation;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation recipient is not admitted' USING ERRCODE = '23514'; END IF;
    PERFORM 1 FROM access.representation r JOIN access.principal p ON p.id = r.principal_id
        WHERE r.id = NEW.acceptor_representation_id AND r.active AND p.active
            AND r.generation = NEW.acceptor_representation_generation AND r.valid_until > clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation acceptor mandate is stale' USING ERRCODE = '23514'; END IF;
    IF invitation.issuer_lifetime = 'operator-dependent' THEN
        PERFORM 1 FROM access.representation WHERE id = invitation.issuer_representation_id
            AND active AND generation = invitation.issuer_representation_generation
            AND valid_until > clock_timestamp();
        IF NOT FOUND THEN RAISE EXCEPTION 'invitation issuing mandate ended' USING ERRCODE = '23514'; END IF;
    END IF;
    IF invitation.offer = 'manage' THEN
        PERFORM 1 FROM access.grant_lineage l JOIN access.permission_grant g ON g.id = l.grant_id
            WHERE l.grant_id = NEW.grant_id AND l.invitation_id = NEW.invitation_id
                AND l.lifetime = 'institutional' AND g.active AND g.valid_until <= invitation.grant_valid_until;
    ELSIF invitation.offer = 'represent' THEN
        PERFORM 1 FROM access.representation_edge WHERE id = NEW.edge_id
            AND invitation_id = NEW.invitation_id AND action = invitation.action AND active;
    ELSE
        PERFORM 1 FROM access.representation r JOIN access.protected_change_activation a
            ON a.proposal_id = r.protected_change_id
            WHERE r.id = NEW.controller_representation_id AND r.subject_id = invitation.issuer_subject
                AND r.principal_id = NEW.accepted_by_principal AND r.action = 'agent.control' AND r.active
                AND a.kind = 'agent-controller' AND a.activation_txid = txid_current();
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation lacks its offered authority' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;

-- Principal controllers keep their identity and lifetime when revoked. A
-- payload edit or deletion cannot bypass the deferred continuity check.
CREATE FUNCTION access.keep_agent_controller_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.action <> 'agent.control' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
    IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'active' - 'generation')
        IS DISTINCT FROM (to_jsonb(OLD) - 'active' - 'generation') THEN
        RAISE EXCEPTION 'agent controller episode is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_controller_episode BEFORE UPDATE OR DELETE ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.keep_agent_controller_episode();

-- Edge revocation joins the existing strong drain. Keep every previously
-- admitted target kind (043) and both private read lease families (190).
ALTER TABLE access.revocation ADD COLUMN representation_edge_id uuid REFERENCES access.representation_edge(id),
    DROP CONSTRAINT revocation_target_kind_check,
    DROP CONSTRAINT revocation_one_target,
    DROP CONSTRAINT revocation_target_kind,
    ADD CONSTRAINT revocation_target_kind_check CHECK (target_kind IN ('representation','permission_grant',
        'principal_permission_grant','group_permission_grant','role_binding','private_role_binding','representation_edge')),
    ADD CONSTRAINT revocation_one_target CHECK (num_nonnulls(representation_id,permission_grant_id,
        principal_permission_grant_id,group_permission_grant_id,role_binding_id,private_role_binding_id,representation_edge_id) = 1),
    ADD CONSTRAINT revocation_target_kind CHECK (CASE target_kind
        WHEN 'representation_edge' THEN representation_edge_id IS NOT NULL
        WHEN 'representation' THEN representation_id IS NOT NULL
        WHEN 'permission_grant' THEN permission_grant_id IS NOT NULL
        WHEN 'principal_permission_grant' THEN principal_permission_grant_id IS NOT NULL
        WHEN 'group_permission_grant' THEN group_permission_grant_id IS NOT NULL
        WHEN 'role_binding' THEN role_binding_id IS NOT NULL
        ELSE private_role_binding_id IS NOT NULL END);
CREATE UNIQUE INDEX revocation_edge_target ON access.revocation (representation_edge_id)
    WHERE representation_edge_id IS NOT NULL;

CREATE OR REPLACE FUNCTION access.check_revocation_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
    CASE NEW.target_kind
    WHEN 'representation_edge' THEN SELECT e.active,e.generation,e.represented_subject AS issuer,
            i.scope_id INTO target FROM access.representation_edge e
        LEFT JOIN access.agent_invitation i ON i.id = e.invitation_id WHERE e.id = NEW.representation_edge_id;
    WHEN 'representation' THEN SELECT r.active, r.generation, r.subject_id AS issuer,
            NULL::text AS scope_id INTO target
        FROM access.representation r WHERE r.id = NEW.representation_id;
    WHEN 'permission_grant' THEN SELECT g.active, g.generation, g.issuer_subject AS issuer,
            g.scope_id INTO target
        FROM access.permission_grant g WHERE g.id = NEW.permission_grant_id;
    WHEN 'principal_permission_grant' THEN SELECT g.active, g.generation,
            g.issuer_subject AS issuer, g.scope_id INTO target
        FROM access.principal_permission_grant g WHERE g.id = NEW.principal_permission_grant_id;
    WHEN 'group_permission_grant' THEN SELECT g.active, g.generation,
            g.issuer_subject AS issuer, g.scope_id INTO target
        FROM access.group_permission_grant g WHERE g.id = NEW.group_permission_grant_id;
    WHEN 'role_binding' THEN SELECT b.active, b.generation, b.issuer_subject AS issuer,
            f.scope_id INTO target
        FROM access.role_binding b JOIN access.role_family f ON f.id = b.family_id
        WHERE b.id = NEW.role_binding_id;
    ELSE SELECT b.active, b.generation, b.issuer_subject AS issuer, f.scope_id INTO target
        FROM access.private_role_binding b JOIN access.role_family f ON f.id = b.family_id
        WHERE b.id = NEW.private_role_binding_id;
    END CASE;
    IF target.active IS DISTINCT FROM false OR target.generation <> NEW.target_generation
        OR target.issuer IS DISTINCT FROM NEW.issuer_subject
        OR (target.scope_id IS NOT NULL AND target.scope_id <> NEW.scope_id)
        OR NOT EXISTS (SELECT 1 FROM access.scope_gate WHERE id = NEW.scope_id
            AND authority_epoch = NEW.fence_authority_epoch)
        OR NOT EXISTS (SELECT 1 FROM access.recovery_fence WHERE id
            AND generation = NEW.recovery_generation)
        OR (NEW.affected_work > 0 AND NEW.state <> 'draining') THEN
        RAISE EXCEPTION 'revocation does not record one revoked source at its fence'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access.check_revocation_affected_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r access.revocation; linked boolean;
BEGIN
    SELECT * INTO r FROM access.revocation WHERE id = NEW.revocation_id;
    IF r.mode <> 'strong' THEN
        RAISE EXCEPTION 'only a strong revocation drains admitted work' USING ERRCODE = '23514';
    END IF;
    IF NEW.admission_id IS NOT NULL THEN
        SELECT a.state <> 'sealed' AND CASE r.target_kind
            WHEN 'representation_edge' THEN EXISTS (SELECT 1 FROM access.admission_obligation o
                JOIN access.representation_path_step s ON s.path_id = o.path_id
                WHERE o.admission_id = a.id AND s.edge_id = r.representation_edge_id)
            WHEN 'representation' THEN a.represented_representation_id = r.representation_id
            WHEN 'permission_grant' THEN a.represented_grant_id = r.permission_grant_id
            WHEN 'principal_permission_grant' THEN a.direct_grant_id = r.principal_permission_grant_id
            WHEN 'group_permission_grant' THEN r.group_permission_grant_id
                IN (a.group_grant_id, a.private_group_grant_id)
            WHEN 'role_binding' THEN a.role_binding_id = r.role_binding_id
            ELSE a.private_role_binding_id = r.private_role_binding_id END
        INTO linked FROM access.admission a WHERE a.id = NEW.admission_id;
    ELSIF NEW.search_read_lease_id IS NOT NULL THEN
        SELECT l.state IN ('admitted', 'delivering') AND CASE r.target_kind
            WHEN 'representation' THEN l.representation_id = r.representation_id
            WHEN 'permission_grant' THEN l.grant_id = r.permission_grant_id
            ELSE false END
        INTO linked FROM access.search_read_lease l WHERE l.id = NEW.search_read_lease_id;
    ELSE
        SELECT l.state IN ('admitted', 'delivering') AND CASE r.target_kind
            WHEN 'representation' THEN l.representation_id = r.representation_id
            WHEN 'permission_grant' THEN l.grant_id = r.permission_grant_id
            ELSE false END
        INTO linked FROM access.download_read_lease l WHERE l.id = NEW.download_read_lease_id;
    END IF;
    IF linked IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'affected work is not pending on the revoked source'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access.keep_revocation_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.principal_id, NEW.issuer_subject, NEW.mode, NEW.target_kind,
        NEW.representation_edge_id, NEW.representation_id, NEW.permission_grant_id, NEW.principal_permission_grant_id,
        NEW.group_permission_grant_id, NEW.role_binding_id, NEW.private_role_binding_id,
        NEW.target_generation, NEW.scope_id, NEW.fence_authority_epoch,
        NEW.recovery_generation, NEW.affected_work, NEW.requested_at)
        IS DISTINCT FROM
       (OLD.id, OLD.principal_id, OLD.issuer_subject, OLD.mode, OLD.target_kind,
        OLD.representation_edge_id, OLD.representation_id, OLD.permission_grant_id, OLD.principal_permission_grant_id,
        OLD.group_permission_grant_id, OLD.role_binding_id, OLD.private_role_binding_id,
        OLD.target_generation, OLD.scope_id, OLD.fence_authority_epoch,
        OLD.recovery_generation, OLD.affected_work, OLD.requested_at)
        OR OLD.state <> 'draining' OR NEW.state <> 'completed' THEN
        RAISE EXCEPTION 'revocation identity is immutable and only draining completes'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM access.revocation_affected_work w
            JOIN access.admission a ON a.id = w.admission_id
            WHERE w.revocation_id = NEW.id AND a.state <> 'sealed')
        OR EXISTS (SELECT 1 FROM access.revocation_affected_work w
            JOIN access.search_read_lease l ON l.id = w.search_read_lease_id
            WHERE w.revocation_id = NEW.id AND l.state IN ('admitted', 'delivering'))
        OR EXISTS (SELECT 1 FROM access.revocation_affected_work w
            JOIN access.download_read_lease l ON l.id = w.download_read_lease_id
            WHERE w.revocation_id = NEW.id AND l.state IN ('admitted', 'delivering')) THEN
        RAISE EXCEPTION 'revocation still has admitted work pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- A controller mandate identifies the Person; the accepted edge supplies the
-- publishing action. Keep these two meanings in the existing path proof rather
-- than issuing a duplicate work.create mandate. Legacy action-preserving paths
-- fill their mandate action from the obligation and retain their limits.
ALTER TABLE access.representation_path_proof ADD COLUMN mandate_action text;
ALTER TABLE access.representation_path_proof DISABLE TRIGGER representation_path_proof_immutable;
UPDATE access.representation_path_proof SET mandate_action = action;
ALTER TABLE access.representation_path_proof ENABLE TRIGGER representation_path_proof_immutable;
ALTER TABLE access.representation_path_proof ALTER COLUMN mandate_action SET NOT NULL;
DO $$ DECLARE constraint_name text;
BEGIN
    SELECT conname INTO STRICT constraint_name FROM pg_constraint
        WHERE conrelid = 'access.representation_path_proof'::regclass AND contype = 'f'
            AND confrelid = 'access.representation'::regclass;
    EXECUTE format('ALTER TABLE access.representation_path_proof DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE access.representation_path_proof ADD CONSTRAINT path_origin_mandate
    FOREIGN KEY (representation_id,principal_id,origin_subject,mandate_action)
        REFERENCES access.representation(id,principal_id,subject_id,action);
CREATE FUNCTION access.fill_path_mandate_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.mandate_action := coalesce(NEW.mandate_action,NEW.action); RETURN NEW; END $$;
CREATE TRIGGER representation_path_mandate_action BEFORE INSERT ON access.representation_path_proof
    FOR EACH ROW EXECUTE FUNCTION access.fill_path_mandate_action();

CREATE OR REPLACE FUNCTION access.check_representation_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE proof record; step record; expected smallint := 0; previous text; path uuid;
BEGIN
    IF TG_TABLE_NAME = 'representation_path_proof' THEN path := NEW.id;
    ELSE path := NEW.path_id; END IF;
    SELECT p.*,r.max_path_edges AS mandate_limit,r.valid_until AS mandate_until
        INTO proof FROM access.representation_path_proof p
        JOIN access.representation r ON r.id = p.representation_id WHERE p.id = path;
    IF NOT FOUND THEN RAISE EXCEPTION 'representation path proof is missing' USING ERRCODE = '23514'; END IF;
    IF proof.mandate_action <> proof.action THEN
        IF proof.mandate_action <> 'agent.control' OR proof.action <> 'work.create' OR proof.edge_count <> 1
            OR NOT EXISTS (SELECT 1 FROM access.agent_provision WHERE agent_id = proof.origin_subject
                AND agent_kind = 'person' AND state = 'active') THEN
            RAISE EXCEPTION 'controller path lacks its publishing offer' USING ERRCODE = '23514';
        END IF;
        proof.mandate_limit := 1;
    END IF;
    IF proof.valid_until > proof.mandate_until
        OR (proof.edge_count > 0 AND proof.edge_count > proof.mandate_limit) THEN
        RAISE EXCEPTION 'representation path exceeds its mandate' USING ERRCODE = '23514';
    END IF;
    previous := proof.origin_subject;
    FOR step IN SELECT s.*,e.max_path_edges,e.valid_until,e.resource_subject,e.invitation_id
        FROM access.representation_path_step s JOIN access.representation_edge e ON e.id = s.edge_id
        WHERE s.path_id = path ORDER BY s.position
    LOOP
        expected := expected + 1;
        IF step.position <> expected OR step.representative_subject <> previous
            OR step.action <> proof.action OR step.max_path_edges < proof.edge_count
            OR step.valid_until < proof.valid_until THEN
            RAISE EXCEPTION 'representation path is not one bounded chain' USING ERRCODE = '23514';
        END IF;
        IF proof.mandate_action <> proof.action AND (step.resource_subject IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM access.agent_invitation i
                JOIN access.agent_invitation_acceptance a ON a.invitation_id = i.id
                WHERE i.id = step.invitation_id AND i.offer = 'represent'
                    AND i.scope_id = 'work:create:root' AND proof.action = ANY(i.actions)
                    AND NOT EXISTS (SELECT 1 FROM access.agent_invitation_revocation v WHERE v.invitation_id = i.id))) THEN
            RAISE EXCEPTION 'controller path lacks its accepted edge' USING ERRCODE = '23514';
        END IF;
        previous := step.represented_subject;
    END LOOP;
    IF expected <> proof.edge_count OR previous <> proof.acting_subject THEN
        RAISE EXCEPTION 'representation path is not one bounded chain' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
