-- The recipient's immutable consent is an Access-owned admission artifact.
-- Revocation and one-use consumption are separate immutable facts.
CREATE TABLE access.membership_consent (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    kind text NOT NULL,
    owner_subject text NOT NULL,
    member_subject text NOT NULL REFERENCES access.authority_subject(id),
    member_generation bigint NOT NULL CHECK (member_generation >= 0),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text NOT NULL CHECK (length(terms_revision) BETWEEN 1 AND 128),
    next_generation bigint NOT NULL CHECK (next_generation >= 1),
    representation_id uuid NOT NULL REFERENCES access.representation(id),
    representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
    grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
    grant_generation bigint NOT NULL CHECK (grant_generation >= 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (kind, owner_subject) REFERENCES access.membership_policy(kind, owner_subject),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX membership_consent_principal_lookup
    ON access.membership_consent (principal_id, id);
CREATE INDEX membership_consent_eligible_grant
    ON access.permission_grant (recipient_subject, scope_id, valid_until)
    WHERE active AND action = 'access.membership.consent' AND membership_id IS NULL;
CREATE TABLE access.membership_consent_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    consent_id uuid NOT NULL REFERENCES access.membership_consent(id),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TABLE access.membership_consent_revocation (
    consent_id uuid PRIMARY KEY REFERENCES access.membership_consent(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE access.membership_consent_use (
    consent_id uuid PRIMARY KEY REFERENCES access.membership_consent(id),
    membership_id uuid NOT NULL REFERENCES access.membership(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    UNIQUE (membership_id, generation)
);
CREATE TRIGGER membership_consent_immutable BEFORE UPDATE OR DELETE
    ON access.membership_consent FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER membership_consent_revocation_immutable BEFORE UPDATE OR DELETE
    ON access.membership_consent_revocation FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER membership_consent_use_immutable BEFORE UPDATE OR DELETE
    ON access.membership_consent_use FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER membership_consent_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.membership_consent_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
