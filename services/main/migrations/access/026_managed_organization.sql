-- Explicit management authority is independent of structural participation.
CREATE TABLE access.managed_org_grant (
    id uuid PRIMARY KEY,
    organization_subject text NOT NULL REFERENCES access.org_participation_subject(subject),
    organization_generation bigint NOT NULL CHECK (organization_generation >= 0),
    organization_admission_generation bigint NOT NULL CHECK (organization_admission_generation >= 0),
    recipient_kind text NOT NULL CHECK (recipient_kind IN ('realm', 'parent')),
    recipient_id text NOT NULL CHECK (recipient_id ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    recipient_realm text REFERENCES access.org_realm_policy(realm),
    recipient_parent text REFERENCES access.org_participation_subject(subject),
    recipient_subject text NOT NULL REFERENCES access.authority_subject(id),
    recipient_generation bigint NOT NULL CHECK (recipient_generation >= 0),
    recipient_admission_generation bigint NOT NULL CHECK (recipient_admission_generation >= 0),
    resource_kind text NOT NULL DEFAULT 'org-roster' CHECK (resource_kind = 'org-roster'),
    action text NOT NULL CHECK (action = 'access.org.roster.policy'),
    delegation_ceiling integer NOT NULL CHECK (delegation_ceiling = 0),
    valid_from timestamptz NOT NULL,
    valid_until timestamptz NOT NULL,
    issuer_proof jsonb NOT NULL CHECK (jsonb_typeof(issuer_proof) = 'object'),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 1 CHECK (generation IN (1, 2)),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (organization_subject <> recipient_subject),
    CHECK (recipient_realm IS NOT DISTINCT FROM CASE WHEN recipient_kind = 'realm' THEN recipient_id END),
    CHECK (recipient_parent IS NOT DISTINCT FROM CASE WHEN recipient_kind = 'parent' THEN recipient_id END),
    CHECK (valid_until > valid_from AND valid_until <= valid_from + interval '30 days'
        AND valid_until <= created_at + interval '30 days'),
    CHECK (active = (generation = 1))
);
CREATE INDEX managed_org_grant_organization ON access.managed_org_grant (organization_subject, id);
CREATE INDEX managed_org_grant_recipient ON access.managed_org_grant (recipient_subject, id);
CREATE INDEX managed_org_grant_realm_fk ON access.managed_org_grant (recipient_realm)
    WHERE recipient_realm IS NOT NULL;
CREATE INDEX managed_org_grant_parent_fk ON access.managed_org_grant (recipient_parent)
    WHERE recipient_parent IS NOT NULL;

CREATE FUNCTION access.guard_managed_org_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'managed grant identity cannot be erased' USING ERRCODE = '23514';
    ELSIF TG_OP = 'INSERT' THEN
        IF NOT NEW.active OR NEW.generation <> 1 THEN
            RAISE EXCEPTION 'managed grant must start active' USING ERRCODE = '23514';
        END IF;
    ELSIF (to_jsonb(NEW) - 'active' - 'generation') <> (to_jsonb(OLD) - 'active' - 'generation')
        OR NOT OLD.active OR NEW.active OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'managed grant payload is immutable; only revoke is allowed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER managed_org_grant_lifecycle BEFORE INSERT OR UPDATE OR DELETE
    ON access.managed_org_grant FOR EACH ROW EXECUTE FUNCTION access.guard_managed_org_grant();

CREATE TABLE access.managed_org_grant_event (
    grant_id uuid NOT NULL REFERENCES access.managed_org_grant(id),
    generation bigint NOT NULL CHECK (generation IN (1, 2)),
    operation text NOT NULL CHECK (operation IN ('issue', 'revoke')),
    actor_proof jsonb NOT NULL CHECK (jsonb_typeof(actor_proof) = 'object'),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (grant_id, generation),
    CHECK ((operation = 'issue') = (generation = 1))
);
CREATE TABLE access.org_roster_policy_history (
    organization_subject text NOT NULL REFERENCES access.org_participation_subject(subject),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
    admissions_open boolean NOT NULL,
    grant_id uuid NOT NULL REFERENCES access.managed_org_grant(id),
    grant_generation bigint NOT NULL CHECK (grant_generation = 1),
    actor_proof jsonb NOT NULL CHECK (jsonb_typeof(actor_proof) = 'object'),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_subject, policy_revision)
);
CREATE INDEX org_roster_history_grant ON access.org_roster_policy_history (grant_id);
CREATE TABLE access.managed_org_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation IN ('issue', 'revoke', 'roster-policy')),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER managed_org_event_immutable BEFORE UPDATE OR DELETE
    ON access.managed_org_grant_event FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER org_roster_policy_history_immutable BEFORE UPDATE OR DELETE
    ON access.org_roster_policy_history FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER managed_org_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.managed_org_receipt FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE INDEX managed_org_issuer_grant ON access.permission_grant
    (recipient_subject, scope_id, action, valid_until, id)
    WHERE active AND membership_id IS NULL
        AND action IN ('access.org.managed.grant', 'access.org.managed.assign.roster-policy');
CREATE INDEX managed_org_representation ON access.representation
    (principal_id, subject_id, action, valid_until, id)
    WHERE active AND action IN ('access.org.managed.grant', 'access.org.roster.policy');
