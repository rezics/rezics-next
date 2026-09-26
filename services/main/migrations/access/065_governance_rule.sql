-- Governance rules are published under the responsible Access scope. The
-- immutable revision is the decision's exact rule basis; a head change makes
-- a pending decision stale without rewriting the earlier rule.
CREATE TABLE access.governance_rule_head (
    ref text PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 512),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    revision bigint NOT NULL CHECK (revision >= 1),
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    UNIQUE (ref, scope_id)
);

CREATE TABLE access.governance_rule_revision (
    ref text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 1),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (ref, revision),
    UNIQUE (principal_id, idempotency_key),
    FOREIGN KEY (ref, scope_id) REFERENCES access.governance_rule_head(ref, scope_id)
        DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE access.governance_rule_head ADD CONSTRAINT governance_rule_head_revision_fk
    FOREIGN KEY (ref, revision) REFERENCES access.governance_rule_revision(ref, revision)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX governance_rule_revision_scope_page
    ON access.governance_rule_revision (scope_id, published_at, ref, revision);

CREATE FUNCTION access.guard_governance_rule_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'governance rule revision is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER governance_rule_revision_immutable BEFORE UPDATE OR DELETE
    ON access.governance_rule_revision FOR EACH ROW EXECUTE FUNCTION access.guard_governance_rule_revision();
