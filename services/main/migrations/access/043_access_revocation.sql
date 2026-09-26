-- IAM07/IAM29: a revocation request records exactly one already-revoked authority
-- source and the existing scope authority epoch that fences new admission. A
-- strong request also fixes the admitted command and private-read work that must
-- reach a terminal outcome before completion; elapsed time cannot complete it.
-- Other independent sources are separate rows and are never touched.
CREATE TABLE access.revocation (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    mode text NOT NULL CHECK (mode IN ('ordinary', 'strong')),
    target_kind text NOT NULL CHECK (target_kind IN ('representation', 'permission_grant',
        'principal_permission_grant', 'group_permission_grant', 'role_binding',
        'private_role_binding')),
    representation_id uuid REFERENCES access.representation(id),
    permission_grant_id uuid REFERENCES access.permission_grant(id),
    principal_permission_grant_id uuid REFERENCES access.principal_permission_grant(id),
    group_permission_grant_id uuid REFERENCES access.group_permission_grant(id),
    role_binding_id uuid REFERENCES access.role_binding(id),
    private_role_binding_id uuid REFERENCES access.private_role_binding(id),
    target_generation bigint NOT NULL CHECK (target_generation >= 1),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    fence_authority_epoch bigint NOT NULL CHECK (fence_authority_epoch >= 1),
    recovery_generation bigint NOT NULL CHECK (recovery_generation >= 0),
    affected_work smallint NOT NULL CHECK (affected_work BETWEEN 0 AND 256),
    state text NOT NULL CHECK (state IN ('draining', 'completed')),
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    CONSTRAINT revocation_one_target CHECK (num_nonnulls(representation_id,
        permission_grant_id, principal_permission_grant_id, group_permission_grant_id,
        role_binding_id, private_role_binding_id) = 1),
    CONSTRAINT revocation_target_kind CHECK (CASE target_kind
        WHEN 'representation' THEN representation_id IS NOT NULL
        WHEN 'permission_grant' THEN permission_grant_id IS NOT NULL
        WHEN 'principal_permission_grant' THEN principal_permission_grant_id IS NOT NULL
        WHEN 'group_permission_grant' THEN group_permission_grant_id IS NOT NULL
        WHEN 'role_binding' THEN role_binding_id IS NOT NULL
        ELSE private_role_binding_id IS NOT NULL END),
    CONSTRAINT revocation_completion CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
    -- Ordinary revocation only fences later admission; earlier admitted work keeps
    -- its finite contract and is not reported as drained.
    CONSTRAINT revocation_ordinary_contract CHECK
        (mode = 'strong' OR (state = 'completed' AND affected_work = 0))
);
CREATE UNIQUE INDEX revocation_representation_target ON access.revocation
    (representation_id) WHERE representation_id IS NOT NULL;
CREATE UNIQUE INDEX revocation_permission_grant_target ON access.revocation
    (permission_grant_id) WHERE permission_grant_id IS NOT NULL;
CREATE UNIQUE INDEX revocation_principal_grant_target ON access.revocation
    (principal_permission_grant_id) WHERE principal_permission_grant_id IS NOT NULL;
CREATE UNIQUE INDEX revocation_group_grant_target ON access.revocation
    (group_permission_grant_id) WHERE group_permission_grant_id IS NOT NULL;
CREATE UNIQUE INDEX revocation_role_binding_target ON access.revocation
    (role_binding_id) WHERE role_binding_id IS NOT NULL;
CREATE UNIQUE INDEX revocation_private_role_binding_target ON access.revocation
    (private_role_binding_id) WHERE private_role_binding_id IS NOT NULL;
CREATE INDEX revocation_draining_scope ON access.revocation (scope_id, id)
    WHERE state = 'draining';
CREATE INDEX revocation_issuer_page ON access.revocation (issuer_subject, id);

CREATE FUNCTION access.check_revocation_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
    CASE NEW.target_kind
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
CREATE TRIGGER revocation_target_revoked BEFORE INSERT
    ON access.revocation FOR EACH ROW EXECUTE FUNCTION access.check_revocation_target();

-- The drain list is fixed when the fence commits. Each row is admitted work whose
-- selected proof used the revoked source and was not yet terminal.
CREATE TABLE access.revocation_affected_work (
    revocation_id uuid NOT NULL REFERENCES access.revocation(id),
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 256),
    admission_id uuid REFERENCES access.admission(id),
    search_read_lease_id uuid REFERENCES access.search_read_lease(id),
    PRIMARY KEY (revocation_id, ordinal),
    CONSTRAINT revocation_affected_one_work CHECK
        (num_nonnulls(admission_id, search_read_lease_id) = 1)
);
CREATE UNIQUE INDEX revocation_affected_admission ON access.revocation_affected_work
    (admission_id, revocation_id) WHERE admission_id IS NOT NULL;
CREATE UNIQUE INDEX revocation_affected_read ON access.revocation_affected_work
    (search_read_lease_id, revocation_id) WHERE search_read_lease_id IS NOT NULL;

CREATE FUNCTION access.check_revocation_affected_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r access.revocation; linked boolean;
BEGIN
    SELECT * INTO r FROM access.revocation WHERE id = NEW.revocation_id;
    IF r.mode <> 'strong' THEN
        RAISE EXCEPTION 'only a strong revocation drains admitted work' USING ERRCODE = '23514';
    END IF;
    IF NEW.admission_id IS NOT NULL THEN
        SELECT a.state <> 'sealed' AND CASE r.target_kind
            WHEN 'representation' THEN a.represented_representation_id = r.representation_id
            WHEN 'permission_grant' THEN a.represented_grant_id = r.permission_grant_id
            WHEN 'principal_permission_grant' THEN a.direct_grant_id = r.principal_permission_grant_id
            WHEN 'group_permission_grant' THEN r.group_permission_grant_id
                IN (a.group_grant_id, a.private_group_grant_id)
            WHEN 'role_binding' THEN a.role_binding_id = r.role_binding_id
            ELSE a.private_role_binding_id = r.private_role_binding_id END
        INTO linked FROM access.admission a WHERE a.id = NEW.admission_id;
    ELSE
        SELECT l.state IN ('admitted', 'delivering') AND CASE r.target_kind
            WHEN 'representation' THEN l.representation_id = r.representation_id
            WHEN 'permission_grant' THEN l.grant_id = r.permission_grant_id
            ELSE false END
        INTO linked FROM access.search_read_lease l WHERE l.id = NEW.search_read_lease_id;
    END IF;
    IF linked IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'affected work is not pending on the revoked source'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER revocation_affected_work_linked BEFORE INSERT
    ON access.revocation_affected_work FOR EACH ROW
    EXECUTE FUNCTION access.check_revocation_affected_work();
CREATE TRIGGER revocation_affected_work_immutable BEFORE UPDATE OR DELETE
    ON access.revocation_affected_work FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();

CREATE FUNCTION access.check_revocation_drain_list() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target uuid; declared smallint; listed integer;
BEGIN
    IF TG_TABLE_NAME = 'revocation' THEN target := NEW.id;
    ELSE target := NEW.revocation_id; END IF;
    SELECT affected_work INTO declared FROM access.revocation WHERE id = target;
    SELECT count(*) INTO listed FROM access.revocation_affected_work
        WHERE revocation_id = target;
    IF listed <> declared THEN
        RAISE EXCEPTION 'revocation drain list differs from its fence' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER revocation_drain_list_count AFTER INSERT
    ON access.revocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.check_revocation_drain_list();
CREATE CONSTRAINT TRIGGER revocation_affected_work_count AFTER INSERT
    ON access.revocation_affected_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.check_revocation_drain_list();

-- Completion is acknowledged only after every listed command is sealed and every
-- listed private read reached delivered, aborted or expired.
CREATE FUNCTION access.keep_revocation_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.principal_id, NEW.issuer_subject, NEW.mode, NEW.target_kind,
        NEW.representation_id, NEW.permission_grant_id, NEW.principal_permission_grant_id,
        NEW.group_permission_grant_id, NEW.role_binding_id, NEW.private_role_binding_id,
        NEW.target_generation, NEW.scope_id, NEW.fence_authority_epoch,
        NEW.recovery_generation, NEW.affected_work, NEW.requested_at)
        IS DISTINCT FROM
       (OLD.id, OLD.principal_id, OLD.issuer_subject, OLD.mode, OLD.target_kind,
        OLD.representation_id, OLD.permission_grant_id, OLD.principal_permission_grant_id,
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
            WHERE w.revocation_id = NEW.id AND l.state IN ('admitted', 'delivering')) THEN
        RAISE EXCEPTION 'revocation still has admitted work pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER revocation_completion_order BEFORE UPDATE
    ON access.revocation FOR EACH ROW EXECUTE FUNCTION access.keep_revocation_completion();
CREATE TRIGGER revocation_retained BEFORE DELETE
    ON access.revocation FOR EACH ROW EXECUTE FUNCTION access.reject_policy_record_mutation();

-- Same principal/key/digest receipt shape as grant_change_receipt (017).
CREATE TABLE access.revocation_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    revocation_id uuid NOT NULL REFERENCES access.revocation(id),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER revocation_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.revocation_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();
