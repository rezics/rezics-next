-- A recipient is the verified Account principal, never a public Agent surrogate.
-- Existing Org and Realm policies remain independent. Only Access may resolve a
-- consent handle to its private principal; managers receive no Account binding.
CREATE TABLE access.private_membership_ban (
    kind text NOT NULL,
    owner_subject text NOT NULL,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    active boolean NOT NULL DEFAULT true,
    reason_ref text NOT NULL CHECK (length(reason_ref) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, owner_subject, principal_id),
    FOREIGN KEY (kind, owner_subject) REFERENCES access.membership_policy(kind, owner_subject)
);

CREATE TABLE access.private_membership (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    owner_subject text NOT NULL,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    state text NOT NULL CHECK (state IN ('joined', 'left')),
    generation bigint NOT NULL CHECK (generation >= 1),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text,
    consent_reference uuid,
    changed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, owner_subject, principal_id),
    FOREIGN KEY (kind, owner_subject) REFERENCES access.membership_policy(kind, owner_subject),
    CHECK ((state = 'joined' AND terms_revision IS NOT NULL AND consent_reference IS NOT NULL)
        OR (state = 'left' AND terms_revision IS NULL AND consent_reference IS NULL))
);
CREATE INDEX private_membership_recipient_page ON access.private_membership (principal_id, id);

CREATE FUNCTION access.keep_private_membership_episode_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.owner_subject IS DISTINCT FROM OLD.owner_subject
        OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
        OR NEW.generation <> OLD.generation + 1 OR NEW.state = OLD.state THEN
        RAISE EXCEPTION 'private membership identity and episode order are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER private_membership_episode_order BEFORE UPDATE
    ON access.private_membership FOR EACH ROW
    EXECUTE FUNCTION access.keep_private_membership_episode_order();

CREATE TABLE access.private_membership_history (
    membership_id uuid NOT NULL REFERENCES access.private_membership(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    state text NOT NULL CHECK (state IN ('joined', 'left')),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text,
    consent_reference uuid,
    changed_by_principal uuid NOT NULL REFERENCES access.principal(id),
    changed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (membership_id, generation)
);
CREATE TRIGGER private_membership_history_immutable BEFORE UPDATE OR DELETE
    ON access.private_membership_history FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE TABLE access.private_membership_consent (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    kind text NOT NULL,
    owner_subject text NOT NULL,
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text NOT NULL CHECK (length(terms_revision) BETWEEN 1 AND 128),
    next_generation bigint NOT NULL CHECK (next_generation >= 1),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (kind, owner_subject) REFERENCES access.membership_policy(kind, owner_subject),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX private_membership_consent_recipient ON access.private_membership_consent (principal_id, id);
CREATE TRIGGER private_membership_consent_immutable BEFORE UPDATE OR DELETE
    ON access.private_membership_consent FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
ALTER TABLE access.private_membership
    ADD CONSTRAINT private_membership_current_consent_fk
    FOREIGN KEY (consent_reference) REFERENCES access.private_membership_consent(id);
ALTER TABLE access.private_membership_history
    ADD CONSTRAINT private_membership_history_consent_fk
    FOREIGN KEY (consent_reference) REFERENCES access.private_membership_consent(id);

CREATE TABLE access.private_membership_consent_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    consent_id uuid NOT NULL REFERENCES access.private_membership_consent(id),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER private_membership_consent_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.private_membership_consent_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE TABLE access.private_membership_consent_revocation (
    consent_id uuid PRIMARY KEY REFERENCES access.private_membership_consent(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER private_membership_consent_revocation_immutable BEFORE UPDATE OR DELETE
    ON access.private_membership_consent_revocation FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE TABLE access.private_membership_consent_use (
    consent_id uuid PRIMARY KEY REFERENCES access.private_membership_consent(id),
    membership_id uuid NOT NULL REFERENCES access.private_membership(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    UNIQUE (membership_id, generation)
);
CREATE TRIGGER private_membership_consent_use_immutable BEFORE UPDATE OR DELETE
    ON access.private_membership_consent_use FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE TABLE access.private_membership_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    membership_id uuid NOT NULL REFERENCES access.private_membership(id),
    result_generation bigint NOT NULL CHECK (result_generation >= 1),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    action text NOT NULL CHECK (action IN ('join', 'leave')),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER private_membership_change_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.private_membership_change_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

-- A principal grant can depend on exactly one private membership episode.
ALTER TABLE access.principal_permission_grant
    ADD COLUMN private_membership_id uuid REFERENCES access.private_membership(id),
    ADD COLUMN private_membership_generation bigint,
    ADD CONSTRAINT principal_grant_private_membership_pair CHECK
        ((private_membership_id IS NULL AND private_membership_generation IS NULL)
          OR (private_membership_id IS NOT NULL AND private_membership_generation >= 1));
CREATE INDEX principal_grant_private_membership_active
    ON access.principal_permission_grant (private_membership_id, id)
    WHERE active AND private_membership_id IS NOT NULL;
CREATE FUNCTION access.check_principal_grant_private_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND
        (NEW.private_membership_id IS DISTINCT FROM OLD.private_membership_id
          OR NEW.private_membership_generation IS DISTINCT FROM OLD.private_membership_generation) THEN
        RAISE EXCEPTION 'private membership dependency is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT NEW.active OR NEW.private_membership_id IS NULL THEN RETURN NEW; END IF;
    PERFORM 1 FROM access.private_membership m JOIN access.principal p ON p.id = m.principal_id
      WHERE m.id = NEW.private_membership_id AND m.principal_id = NEW.principal_id
        AND m.state = 'joined' AND m.generation = NEW.private_membership_generation
        AND p.active FOR SHARE OF m, p;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'inactive or stale private membership dependency' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER principal_grant_private_membership_valid BEFORE INSERT OR UPDATE
    ON access.principal_permission_grant FOR EACH ROW
    EXECUTE FUNCTION access.check_principal_grant_private_membership();
