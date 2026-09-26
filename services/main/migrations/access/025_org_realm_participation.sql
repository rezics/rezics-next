-- Typed Access admission records, independent of public metadata and Agent rosters.
CREATE TABLE access.org_participation_subject (
    subject text PRIMARY KEY REFERENCES access.authority_subject(id),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE access.org_realm_policy (
    realm text PRIMARY KEY CHECK (realm ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
    manager_subject text NOT NULL REFERENCES access.authority_subject(id),
    revision bigint NOT NULL CHECK (revision >= 0),
    terms_revision text NOT NULL CHECK (length(terms_revision) BETWEEN 1 AND 128),
    open boolean NOT NULL DEFAULT true
);
CREATE TABLE access.org_realm_ban (
    realm text NOT NULL REFERENCES access.org_realm_policy(realm),
    organization_subject text NOT NULL REFERENCES access.org_participation_subject(subject),
    active boolean NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 1),
    reason_reference text NOT NULL CHECK (length(reason_reference) BETWEEN 1 AND 128),
    PRIMARY KEY (realm, organization_subject)
);
CREATE TABLE access.org_realm_proposal (
    id uuid PRIMARY KEY,
    realm text NOT NULL REFERENCES access.org_realm_policy(realm),
    organization_subject text NOT NULL REFERENCES access.org_participation_subject(subject),
    next_generation bigint NOT NULL CHECK (next_generation >= 1),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text NOT NULL CHECK (length(terms_revision) BETWEEN 1 AND 128),
    organization_generation bigint NOT NULL CHECK (organization_generation >= 0),
    organization_admission_generation bigint NOT NULL CHECK (organization_admission_generation >= 0),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    realm_proof jsonb NOT NULL CHECK (jsonb_typeof(realm_proof) = 'object'),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE TABLE access.org_realm_participation (
    id uuid PRIMARY KEY,
    realm text NOT NULL REFERENCES access.org_realm_policy(realm),
    organization_subject text NOT NULL REFERENCES access.org_participation_subject(subject),
    generation bigint NOT NULL CHECK (generation >= 1),
    state text NOT NULL CHECK (state IN ('joined', 'left', 'suspended')),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text NOT NULL,
    proposal_id uuid REFERENCES access.org_realm_proposal(id),
    UNIQUE (realm, organization_subject),
    CHECK (state <> 'joined' OR proposal_id IS NOT NULL)
);
CREATE TABLE access.org_realm_history (
    participation_id uuid NOT NULL REFERENCES access.org_realm_participation(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    action text NOT NULL CHECK (action IN ('join', 'leave', 'suspend', 'lift-ban')),
    state text NOT NULL CHECK (state IN ('joined', 'left', 'suspended')),
    policy_revision bigint NOT NULL,
    terms_revision text NOT NULL,
    proposal_id uuid REFERENCES access.org_realm_proposal(id),
    ban_active boolean NOT NULL,
    ban_generation bigint NOT NULL CHECK (ban_generation >= 0),
    reason_reference text CHECK (reason_reference IS NULL OR length(reason_reference) BETWEEN 1 AND 128),
    actor_proof jsonb NOT NULL CHECK (jsonb_typeof(actor_proof) = 'object'),
    authority_epoch bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (participation_id, generation),
    CHECK ((action IN ('suspend', 'lift-ban')) = (reason_reference IS NOT NULL))
);
CREATE TABLE access.org_realm_proposal_use (
    proposal_id uuid PRIMARY KEY REFERENCES access.org_realm_proposal(id),
    participation_id uuid NOT NULL,
    generation bigint NOT NULL,
    FOREIGN KEY (participation_id, generation)
        REFERENCES access.org_realm_history(participation_id, generation),
    UNIQUE (participation_id, generation)
);
CREATE TABLE access.org_realm_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation IN ('propose', 'join', 'leave', 'suspend', 'lift-ban')),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER org_realm_proposal_immutable BEFORE UPDATE OR DELETE
    ON access.org_realm_proposal FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER org_realm_history_immutable BEFORE UPDATE OR DELETE
    ON access.org_realm_history FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER org_realm_proposal_use_immutable BEFORE UPDATE OR DELETE
    ON access.org_realm_proposal_use FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER org_realm_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.org_realm_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE FUNCTION access.guard_org_realm_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Org/Realm identity cannot be erased' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.generation <> 1 THEN
            RAISE EXCEPTION 'Org/Realm first generation must be one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.realm <> OLD.realm OR NEW.organization_subject <> OLD.organization_subject
        OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'Org/Realm identity or generation changed illegally' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'org_realm_participation' THEN
        IF NEW.id <> OLD.id THEN
            RAISE EXCEPTION 'Org/Realm tuple cannot be retargeted' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER org_realm_participation_lifecycle BEFORE INSERT OR UPDATE OR DELETE
    ON access.org_realm_participation FOR EACH ROW
    EXECUTE FUNCTION access.guard_org_realm_lifecycle();
CREATE TRIGGER org_realm_ban_lifecycle BEFORE INSERT OR UPDATE OR DELETE
    ON access.org_realm_ban FOR EACH ROW
    EXECUTE FUNCTION access.guard_org_realm_lifecycle();

CREATE FUNCTION access.guard_org_realm_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.realm <> OLD.realm OR NEW.manager_subject <> OLD.manager_subject
        OR NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'Org/Realm policy identity or revision invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER org_realm_policy_revision BEFORE UPDATE ON access.org_realm_policy
    FOR EACH ROW EXECUTE FUNCTION access.guard_org_realm_policy();

CREATE FUNCTION access.guard_org_participation_subject() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.subject <> OLD.subject OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'Org admission identity or generation invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER org_participation_subject_generation BEFORE UPDATE ON access.org_participation_subject
    FOR EACH ROW EXECUTE FUNCTION access.guard_org_participation_subject();

-- Every proof is a direct, independent grant; participation never mints one.
CREATE INDEX org_realm_authority_grant ON access.permission_grant
    (recipient_subject, scope_id, action, valid_until, id)
    WHERE active AND membership_id IS NULL
        AND action IN ('access.org-realm.admit', 'access.org-realm.participate',
            'access.org-realm.suspend');
CREATE INDEX org_realm_authority_representation ON access.representation
    (principal_id, subject_id, action, valid_until, id)
    WHERE active AND action IN ('access.org-realm.admit', 'access.org-realm.participate',
        'access.org-realm.suspend');
