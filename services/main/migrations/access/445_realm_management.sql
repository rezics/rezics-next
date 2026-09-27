-- Realm bundles materialize ordinary Access grants in the same transaction.
-- The existing moderation/rule authority therefore enforces the previewed set.
CREATE TABLE access.realm_admin_revision (
    realm text PRIMARY KEY,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE access.realm_admin_owner_bootstrap (
    realm text PRIMARY KEY REFERENCES access.realm_admin_revision(realm),
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    admission_id uuid NOT NULL REFERENCES access.admission(id),
    receipt_id uuid NOT NULL,
    principal_id uuid NOT NULL REFERENCES access.principal(id)
);
CREATE TRIGGER realm_admin_owner_bootstrap_immutable BEFORE UPDATE OR DELETE ON access.realm_admin_owner_bootstrap
    FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE TABLE access.realm_admin_role (
    realm text NOT NULL REFERENCES access.realm_admin_revision(realm),
    id uuid NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    permissions text[] NOT NULL CHECK (cardinality(permissions) <= 5 AND permissions <@
        ARRAY['governance.moderate','governance.rule.publish','realm.members.manage',
            'realm.roles.manage','realm.settings.manage']::text[]),
    PRIMARY KEY (realm, id),
    UNIQUE (realm, name)
);
CREATE TABLE access.realm_admin_assignment (
    realm text NOT NULL,
    role_id uuid NOT NULL,
    member text NOT NULL REFERENCES access.authority_subject(id),
    valid_until timestamptz NOT NULL,
    PRIMARY KEY (realm, role_id, member),
    FOREIGN KEY (realm, role_id) REFERENCES access.realm_admin_role(realm, id)
);
CREATE INDEX realm_admin_assignment_member ON access.realm_admin_assignment (realm, member, role_id);
CREATE TABLE access.realm_admin_role_grant (
    realm text NOT NULL,
    role_id uuid NOT NULL,
    member text NOT NULL,
    grant_id uuid NOT NULL UNIQUE REFERENCES access.permission_grant(id),
    PRIMARY KEY (realm, role_id, member, grant_id),
    FOREIGN KEY (realm, role_id, member) REFERENCES access.realm_admin_assignment(realm, role_id, member)
);
CREATE TABLE access.realm_admin_receipt (
    id uuid PRIMARY KEY,
    realm text NOT NULL,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX realm_admin_audit_page ON access.realm_admin_receipt (realm, created_at, id);
CREATE TRIGGER realm_admin_receipt_immutable BEFORE UPDATE OR DELETE ON access.realm_admin_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE FUNCTION access.realm_admin_audit_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM access.advance_realm_management_read_revision(NEW.realm);
    RETURN NEW;
END $$;
CREATE TRIGGER realm_admin_audit_changed AFTER INSERT ON access.realm_admin_receipt
    FOR EACH ROW EXECUTE FUNCTION access.realm_admin_audit_changed();
CREATE TABLE access.realm_admin_escalation (
    id uuid PRIMARY KEY REFERENCES access.realm_admin_receipt(id) DEFERRABLE INITIALLY DEFERRED,
    realm text NOT NULL,
    item_kind text NOT NULL CHECK (item_kind IN ('report','submission')),
    item_id uuid NOT NULL,
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    escalated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (realm, item_kind, item_id)
);
CREATE TRIGGER realm_admin_escalation_immutable BEFORE UPDATE OR DELETE ON access.realm_admin_escalation
    FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE INDEX realm_admin_members_page ON access.membership
    (owner_subject, member_subject) WHERE kind = 'realm';
CREATE INDEX realm_admin_members_search ON access.membership
    (owner_subject, member_subject text_pattern_ops) WHERE kind = 'realm';
ALTER TABLE access.membership_ban ADD COLUMN expires_at timestamptz;
CREATE TABLE access.realm_admin_settings (
    realm text PRIMARY KEY REFERENCES access.realm_admin_revision(realm),
    who_may_submit text NOT NULL CHECK (who_may_submit IN ('granted','members','closed'))
);
