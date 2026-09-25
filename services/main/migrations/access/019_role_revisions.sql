-- First bounded Agent role profile. Bindings pin immutable revisions, so a
-- family head change cannot silently widen an already assigned permission.
CREATE TABLE access.role_family (
    id uuid PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id)
        CHECK (scope_id = 'work:create:root'),
    head_revision bigint NOT NULL CHECK (head_revision BETWEEN 1 AND 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, owner_subject)
);
CREATE TABLE access.role_revision (
    family_id uuid NOT NULL REFERENCES access.role_family(id),
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 32),
    permissions text[] NOT NULL CHECK (
        cardinality(permissions) <= 1
        AND permissions <@ ARRAY['work.create']::text[]),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, revision)
);
ALTER TABLE access.role_family ADD CONSTRAINT role_family_head_fk
    FOREIGN KEY (id, head_revision)
    REFERENCES access.role_revision(family_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE access.role_binding (
    id uuid PRIMARY KEY,
    family_id uuid NOT NULL,
    role_revision bigint NOT NULL,
    issuer_subject text NOT NULL,
    recipient_subject text NOT NULL REFERENCES access.authority_subject(id),
    valid_until timestamptz NOT NULL,
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    assigned_by_principal uuid NOT NULL REFERENCES access.principal(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (family_id, role_revision)
        REFERENCES access.role_revision(family_id, revision),
    FOREIGN KEY (family_id, issuer_subject)
        REFERENCES access.role_family(id, owner_subject),
    UNIQUE (id, family_id, role_revision)
);
CREATE INDEX role_binding_recipient_active ON access.role_binding
    (recipient_subject, valid_until, id) WHERE active;
CREATE INDEX role_binding_issuer_page ON access.role_binding (issuer_subject, id);
CREATE TRIGGER role_binding_generation_advance BEFORE UPDATE
    ON access.role_binding FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();

CREATE TABLE access.role_revision_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    family_id uuid NOT NULL,
    revision bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key),
    FOREIGN KEY (family_id, revision)
        REFERENCES access.role_revision(family_id, revision)
);
CREATE TABLE access.role_binding_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action IN ('bind', 'revoke')),
    binding_id uuid NOT NULL REFERENCES access.role_binding(id),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE FUNCTION access.reject_role_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access role revision/receipt' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER role_revision_immutable BEFORE UPDATE OR DELETE
    ON access.role_revision FOR EACH ROW
    EXECUTE FUNCTION access.reject_role_record_mutation();
CREATE TRIGGER role_revision_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.role_revision_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_role_record_mutation();
CREATE TRIGGER role_binding_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.role_binding_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_role_record_mutation();

-- A represented admission selects exactly one direct grant, group path or
-- role binding and later rechecks that exact identity and pinned revision.
ALTER TABLE access.admission ADD COLUMN role_binding_id uuid
    REFERENCES access.role_binding(id);
ALTER TABLE access.admission ADD COLUMN role_binding_generation bigint;
ALTER TABLE access.admission ADD COLUMN role_family_id uuid;
ALTER TABLE access.admission ADD COLUMN role_revision bigint;
ALTER TABLE access.admission ADD CONSTRAINT role_admission_binding_fk
    FOREIGN KEY (role_binding_id, role_family_id, role_revision)
    REFERENCES access.role_binding(id, family_id, role_revision);
ALTER TABLE access.admission ADD CONSTRAINT role_admission_fields CHECK (
    (role_binding_id IS NULL AND role_binding_generation IS NULL
        AND role_family_id IS NULL AND role_revision IS NULL)
    OR (role_binding_id IS NOT NULL AND role_binding_generation IS NOT NULL
        AND role_family_id IS NOT NULL AND role_revision IS NOT NULL)
);
ALTER TABLE access.admission DROP CONSTRAINT represented_work_admission_proof;
ALTER TABLE access.admission ADD CONSTRAINT represented_work_admission_proof CHECK (
    (represented_representation_id IS NULL
        AND represented_representation_generation IS NULL
        AND represented_grant_id IS NULL AND represented_grant_generation IS NULL
        AND represented_subject_generation IS NULL AND represented_principal_epoch IS NULL
        AND role_binding_id IS NULL)
    OR (authority_path = 'represented-agent' AND action = 'work.create'
        AND scope_id = 'work:create:root'
        AND represented_representation_id IS NOT NULL
        AND represented_representation_generation IS NOT NULL
        AND represented_subject_generation IS NOT NULL
        AND represented_principal_epoch IS NOT NULL
        AND ((represented_grant_id IS NOT NULL AND represented_grant_generation IS NOT NULL
                AND group_grant_id IS NULL AND role_binding_id IS NULL)
            OR (represented_grant_id IS NULL AND represented_grant_generation IS NULL
                AND group_grant_id IS NOT NULL AND role_binding_id IS NULL)
            OR (represented_grant_id IS NULL AND represented_grant_generation IS NULL
                AND group_grant_id IS NULL AND role_binding_id IS NOT NULL)))
);
