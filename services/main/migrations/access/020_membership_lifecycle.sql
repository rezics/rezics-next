-- Org operational membership and Realm participation have separate policies.
-- This first profile admits Agent members; private principal and set selectors
-- require their own admission profiles.
CREATE TABLE access.membership_policy (
    kind text NOT NULL CHECK (kind IN ('org', 'realm')),
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    revision bigint NOT NULL CHECK (revision >= 0),
    terms_revision text NOT NULL CHECK (length(terms_revision) BETWEEN 1 AND 128),
    open boolean NOT NULL DEFAULT true,
    PRIMARY KEY (kind, owner_subject)
);

CREATE TABLE access.membership_ban (
    kind text NOT NULL,
    owner_subject text NOT NULL,
    member_subject text NOT NULL REFERENCES access.authority_subject(id),
    active boolean NOT NULL DEFAULT true,
    reason_ref text NOT NULL CHECK (length(reason_ref) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, owner_subject, member_subject),
    FOREIGN KEY (kind, owner_subject)
        REFERENCES access.membership_policy(kind, owner_subject)
);

CREATE TABLE access.membership (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    owner_subject text NOT NULL,
    member_subject text NOT NULL REFERENCES access.authority_subject(id),
    state text NOT NULL CHECK (state IN ('joined', 'left')),
    generation bigint NOT NULL CHECK (generation >= 1),
    policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
    terms_revision text,
    consent_reference text,
    changed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, owner_subject, member_subject),
    FOREIGN KEY (kind, owner_subject)
        REFERENCES access.membership_policy(kind, owner_subject),
    CHECK ((state = 'joined' AND terms_revision IS NOT NULL
            AND consent_reference IS NOT NULL)
        OR state = 'left')
);
CREATE INDEX membership_member_lookup ON access.membership (member_subject, kind, state);

CREATE TABLE access.membership_history (
    membership_id uuid NOT NULL REFERENCES access.membership(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    state text NOT NULL CHECK (state IN ('joined', 'left')),
    policy_revision bigint NOT NULL,
    terms_revision text,
    consent_reference text,
    changed_by_principal uuid NOT NULL REFERENCES access.principal(id),
    changed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (membership_id, generation)
);

CREATE TABLE access.membership_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    membership_id uuid NOT NULL REFERENCES access.membership(id),
    result_generation bigint NOT NULL,
    result_authority_epoch bigint NOT NULL,
    action text NOT NULL CHECK (action IN ('join', 'leave')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);

CREATE FUNCTION access.reject_membership_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access membership history/receipt' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER membership_history_immutable BEFORE UPDATE OR DELETE
    ON access.membership_history FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TRIGGER membership_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.membership_change_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

-- A dependent direct grant names the exact membership episode it requires.
-- The DB prevents future writes from reactivating a grant from an old episode.
ALTER TABLE access.permission_grant
    ADD COLUMN membership_id uuid REFERENCES access.membership(id),
    ADD COLUMN membership_generation bigint,
    ADD CONSTRAINT grant_membership_dependency_pair CHECK
        ((membership_id IS NULL AND membership_generation IS NULL)
            OR (membership_id IS NOT NULL AND membership_generation IS NOT NULL));
CREATE INDEX grant_membership_active_lookup ON access.permission_grant (membership_id, id)
    WHERE active AND membership_id IS NOT NULL;

CREATE FUNCTION access.check_grant_membership_dependency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_membership record;
BEGIN
    IF NOT NEW.active OR NEW.membership_id IS NULL THEN RETURN NEW; END IF;
    SELECT state, generation, member_subject INTO current_membership
        FROM access.membership WHERE id = NEW.membership_id FOR SHARE;
    IF NOT FOUND OR current_membership.state <> 'joined'
        OR current_membership.generation <> NEW.membership_generation
        OR current_membership.member_subject <> NEW.recipient_subject THEN
        RAISE EXCEPTION 'inactive or stale membership dependency' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER grant_membership_dependency_valid BEFORE INSERT OR UPDATE
    ON access.permission_grant FOR EACH ROW
    EXECUTE FUNCTION access.check_grant_membership_dependency();
