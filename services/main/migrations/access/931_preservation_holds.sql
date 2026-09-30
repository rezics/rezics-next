CREATE TABLE access.governance_preservation_hold (
    id uuid PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    target_resource text NOT NULL,
    author_subject text,
    account_issuer text,
    account_subject text,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    released_at timestamptz,
    UNIQUE (case_id, target_resource)
);
CREATE INDEX governance_hold_target ON access.governance_preservation_hold (target_resource)
    WHERE released_at IS NULL;
CREATE INDEX governance_hold_author ON access.governance_preservation_hold (author_subject)
    WHERE released_at IS NULL;
CREATE INDEX governance_hold_account ON access.governance_preservation_hold (account_issuer, account_subject)
    WHERE released_at IS NULL;
CREATE TABLE access.governance_erasure_postponement (
    hold_id uuid NOT NULL REFERENCES access.governance_preservation_hold(id),
    operation_id text NOT NULL,
    material_ref text NOT NULL,
    reason text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (hold_id, operation_id, material_ref)
);
CREATE TRIGGER governance_erasure_postponement_immutable BEFORE UPDATE OR DELETE
    ON access.governance_erasure_postponement
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
