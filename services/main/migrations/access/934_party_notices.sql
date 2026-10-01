-- Private mandatory inbox. Secrets never enter generic notification payloads or outbox facts.
CREATE TABLE access.safety_party_notice (
    id uuid PRIMARY KEY,
    decision_id uuid NOT NULL REFERENCES access.moderation_decision(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    credential text NOT NULL,
    statement_of_reasons jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (decision_id,principal_id)
);
CREATE INDEX safety_party_notice_page ON access.safety_party_notice (principal_id,id);
CREATE TRIGGER safety_party_notice_immutable BEFORE UPDATE OR DELETE ON access.safety_party_notice
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
