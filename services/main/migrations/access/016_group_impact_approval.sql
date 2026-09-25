-- A proposed populated reparent is a bounded, immutable decision input.
-- Approval and topology activation commit together under the scope gate.
CREATE TABLE access.group_impact_proposal (
    id uuid PRIMARY KEY,
    requested_by uuid NOT NULL REFERENCES access.principal(id),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    group_id uuid NOT NULL REFERENCES access.recipient_group(id),
    parent_id uuid REFERENCES access.recipient_group(id),
    expected_scope_generation bigint NOT NULL CHECK (expected_scope_generation >= 0),
    expected_object_generation bigint NOT NULL CHECK (expected_object_generation >= 0),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    impact_digest text NOT NULL CHECK (impact_digest ~ '^[0-9a-f]{64}$'),
    affected_member_count integer NOT NULL CHECK (affected_member_count BETWEEN 1 AND 1024),
    gained_grant_ids uuid[] NOT NULL,
    lost_grant_ids uuid[] NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (requested_by, idempotency_key),
    CHECK (parent_id IS DISTINCT FROM group_id)
);

CREATE TABLE access.group_impact_activation (
    proposal_id uuid PRIMARY KEY REFERENCES access.group_impact_proposal(id),
    approved_by uuid NOT NULL REFERENCES access.principal(id),
    approval_issuer text NOT NULL REFERENCES access.authority_subject(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    impact_digest text NOT NULL CHECK (impact_digest ~ '^[0-9a-f]{64}$'),
    result_generation bigint NOT NULL CHECK (result_generation >= 0),
    committed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (approved_by, idempotency_key)
);

CREATE FUNCTION access.reject_group_impact_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access group impact record' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER group_impact_proposal_immutable
    BEFORE UPDATE OR DELETE ON access.group_impact_proposal
    FOR EACH ROW EXECUTE FUNCTION access.reject_group_impact_mutation();
CREATE TRIGGER group_impact_activation_immutable
    BEFORE UPDATE OR DELETE ON access.group_impact_activation
    FOR EACH ROW EXECUTE FUNCTION access.reject_group_impact_mutation();
