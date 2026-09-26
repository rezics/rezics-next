-- Private recipients are Access principals, never public Agent subjects. Each
-- recipient row pins one membership episode and cannot be retargeted on rejoin.
ALTER TABLE access.private_membership ADD CONSTRAINT private_membership_id_principal_unique
    UNIQUE (id, principal_id);

CREATE TABLE access.private_group_member (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES access.recipient_group(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    private_membership_id uuid NOT NULL,
    private_membership_generation bigint NOT NULL CHECK (private_membership_generation >= 1),
    assigned_by_principal uuid NOT NULL REFERENCES access.principal(id),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (private_membership_id, principal_id)
        REFERENCES access.private_membership(id, principal_id)
);
CREATE UNIQUE INDEX private_group_member_live_recipient
    ON access.private_group_member (group_id, principal_id) WHERE active;
CREATE INDEX private_group_member_principal_active
    ON access.private_group_member (principal_id, id) WHERE active;
CREATE INDEX private_group_member_group_active
    ON access.private_group_member (group_id, id) WHERE active;
CREATE INDEX private_group_member_episode_active
    ON access.private_group_member (private_membership_id, id) WHERE active;

CREATE TABLE access.private_role_binding (
    id uuid PRIMARY KEY,
    family_id uuid NOT NULL,
    role_revision bigint NOT NULL,
    issuer_subject text NOT NULL,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    private_membership_id uuid NOT NULL,
    private_membership_generation bigint NOT NULL CHECK (private_membership_generation >= 1),
    valid_until timestamptz NOT NULL,
    assigned_by_principal uuid NOT NULL REFERENCES access.principal(id),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, family_id, role_revision),
    FOREIGN KEY (family_id, role_revision)
        REFERENCES access.role_revision(family_id, revision),
    FOREIGN KEY (family_id, issuer_subject)
        REFERENCES access.role_family(id, owner_subject),
    FOREIGN KEY (private_membership_id, principal_id)
        REFERENCES access.private_membership(id, principal_id)
);
CREATE INDEX private_role_binding_principal_active
    ON access.private_role_binding (principal_id, valid_until, id) WHERE active;
CREATE INDEX private_role_binding_episode_active
    ON access.private_role_binding (private_membership_id, id) WHERE active;
CREATE INDEX private_role_binding_issuer_page
    ON access.private_role_binding (issuer_subject, id);

CREATE FUNCTION access.check_private_recipient_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
        OR NEW.private_membership_id IS DISTINCT FROM OLD.private_membership_id
        OR NEW.private_membership_generation IS DISTINCT FROM OLD.private_membership_generation
        OR NEW.assigned_by_principal IS DISTINCT FROM OLD.assigned_by_principal
        OR (NOT OLD.active AND NEW.active)) THEN
        RAISE EXCEPTION 'private recipient dependency and authority are immutable'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'private_group_member' THEN
        IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
            RAISE EXCEPTION 'private group target is immutable' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'private_role_binding' THEN
        IF NEW.family_id IS DISTINCT FROM OLD.family_id
            OR NEW.role_revision IS DISTINCT FROM OLD.role_revision
            OR NEW.issuer_subject IS DISTINCT FROM OLD.issuer_subject
            OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
            RAISE EXCEPTION 'private role target is immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NOT NEW.active THEN RETURN NEW; END IF;
    PERFORM 1 FROM access.private_membership m
      JOIN access.principal p ON p.id = m.principal_id
      WHERE m.id = NEW.private_membership_id AND m.principal_id = NEW.principal_id
        AND m.state = 'joined' AND m.generation = NEW.private_membership_generation
        AND p.active FOR SHARE OF m, p;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'inactive or stale private recipient episode' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER private_group_member_episode_valid BEFORE INSERT OR UPDATE
    ON access.private_group_member FOR EACH ROW
    EXECUTE FUNCTION access.check_private_recipient_episode();
CREATE TRIGGER private_role_binding_episode_valid BEFORE INSERT OR UPDATE
    ON access.private_role_binding FOR EACH ROW
    EXECUTE FUNCTION access.check_private_recipient_episode();
CREATE TABLE access.private_recipient_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('add-group-member', 'revoke-group-member',
        'bind-role', 'revoke-role')),
    object_id uuid NOT NULL,
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    result_group_generation bigint NOT NULL CHECK (result_group_generation >= 0),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER private_recipient_change_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.private_recipient_change_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

ALTER TABLE access.admission
    ADD COLUMN private_group_member_id uuid REFERENCES access.private_group_member(id),
    ADD COLUMN private_group_member_generation bigint,
    ADD COLUMN private_group_grant_id uuid REFERENCES access.group_permission_grant(id),
    ADD COLUMN private_group_grant_generation bigint,
    ADD COLUMN private_group_generation bigint,
    ADD COLUMN private_role_binding_id uuid REFERENCES access.private_role_binding(id),
    ADD COLUMN private_role_binding_generation bigint,
    ADD COLUMN private_role_family_id uuid,
    ADD COLUMN private_role_revision bigint,
    ADD CONSTRAINT private_role_admission_binding_fk
        FOREIGN KEY (private_role_binding_id, private_role_family_id, private_role_revision)
        REFERENCES access.private_role_binding(id, family_id, role_revision);
ALTER TABLE access.admission DROP CONSTRAINT direct_principal_admission_proof;
ALTER TABLE access.admission ADD CONSTRAINT private_group_admission_fields CHECK (
    (private_group_member_id IS NULL AND private_group_member_generation IS NULL
      AND private_group_grant_id IS NULL AND private_group_grant_generation IS NULL
      AND private_group_generation IS NULL)
    OR (private_group_member_id IS NOT NULL AND private_group_member_generation IS NOT NULL
      AND private_group_grant_id IS NOT NULL AND private_group_grant_generation IS NOT NULL
      AND private_group_generation IS NOT NULL)
);
ALTER TABLE access.admission ADD CONSTRAINT private_role_admission_fields CHECK (
    (private_role_binding_id IS NULL AND private_role_binding_generation IS NULL
      AND private_role_family_id IS NULL AND private_role_revision IS NULL)
    OR (private_role_binding_id IS NOT NULL AND private_role_binding_generation IS NOT NULL
      AND private_role_family_id IS NOT NULL AND private_role_revision IS NOT NULL)
);
ALTER TABLE access.admission ADD CONSTRAINT direct_principal_admission_proof CHECK (
    (authority_path = 'represented-agent' AND direct_grant_id IS NULL
        AND attribution_id IS NULL AND direct_grant_generation IS NULL
        AND attribution_generation IS NULL AND direct_subject_generation IS NULL
        AND direct_principal_epoch IS NULL AND private_group_member_id IS NULL
        AND private_group_member_generation IS NULL AND private_group_grant_id IS NULL
        AND private_group_grant_generation IS NULL AND private_group_generation IS NULL
        AND private_role_binding_id IS NULL AND private_role_binding_generation IS NULL
        AND private_role_family_id IS NULL AND private_role_revision IS NULL)
    OR (authority_path = 'direct-principal' AND action = 'work.create'
        AND scope_id = 'work:create:root' AND attribution_id IS NOT NULL
        AND attribution_generation IS NOT NULL AND direct_subject_generation IS NOT NULL
        AND direct_principal_epoch IS NOT NULL
        AND ((direct_grant_id IS NOT NULL AND direct_grant_generation IS NOT NULL
            AND private_group_member_id IS NULL AND private_role_binding_id IS NULL)
          OR (direct_grant_id IS NULL AND direct_grant_generation IS NULL
            AND private_group_member_id IS NOT NULL AND private_group_member_generation IS NOT NULL
            AND private_group_grant_id IS NOT NULL AND private_group_grant_generation IS NOT NULL
            AND private_group_generation IS NOT NULL AND private_role_binding_id IS NULL)
          OR (direct_grant_id IS NULL AND direct_grant_generation IS NULL
            AND private_group_member_id IS NULL AND private_role_binding_id IS NOT NULL
            AND private_role_binding_generation IS NOT NULL AND private_role_family_id IS NOT NULL
            AND private_role_revision IS NOT NULL)))
);
