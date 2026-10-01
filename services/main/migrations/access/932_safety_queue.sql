-- The platform queue is independent of Realm and concept workflows.
ALTER TABLE access.governance_case ADD COLUMN review_pending boolean NOT NULL DEFAULT true;
CREATE TABLE access.site_moderation_position (
    id boolean PRIMARY KEY CHECK (id), revision bigint NOT NULL DEFAULT 0
);
INSERT INTO access.site_moderation_position (id) VALUES (true);
CREATE FUNCTION access.advance_site_moderation_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authority_kind = 'platform' THEN
        UPDATE access.site_moderation_position SET revision = revision + 1 WHERE id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER site_report_position AFTER INSERT OR UPDATE ON access.governance_case
    FOR EACH ROW EXECUTE FUNCTION access.advance_site_moderation_position();
CREATE TRIGGER site_decision_position AFTER INSERT ON access.moderation_decision
    FOR EACH ROW EXECUTE FUNCTION access.advance_site_moderation_position();
CREATE INDEX site_report_queue ON access.governance_case (authority_scope_id,kind,opened_at,id)
    WHERE authority_kind = 'platform' AND state = 'open' AND review_pending;
CREATE INDEX site_decision_log ON access.moderation_decision (authority_scope_id,kind,decided_at,id)
    WHERE authority_kind = 'platform';
CREATE INDEX safety_report_filters ON access.governance_report (case_id,reason_code,content_language);
CREATE INDEX safety_due_steps ON access.governance_process_step (due_at,id) WHERE due_at IS NOT NULL;
CREATE INDEX safety_case_due ON access.governance_process_step (case_id,due_at,id) WHERE due_at IS NOT NULL;
CREATE TABLE access.safety_case_claim (
    case_id uuid PRIMARY KEY REFERENCES access.governance_case(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    case_generation bigint NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > claimed_at)
);
-- A claim is current assignment, not an immutable decision or legal fact.
