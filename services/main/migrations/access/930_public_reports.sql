-- Public intake extends governance; no fabricated Account or acting Agent.
INSERT INTO access.scope_gate (id) VALUES ('governance:platform') ON CONFLICT DO NOTHING;
CREATE TABLE access.governance_role (
    name text PRIMARY KEY,
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array')
);
INSERT INTO access.governance_role VALUES ('platform-safety-specialist', 'governance:platform',
    '["governance.safety.evidence", "governance.moderate", "governance.rights.decide"]');

ALTER TABLE access.governance_case ADD COLUMN urgent boolean NOT NULL DEFAULT false;
ALTER TABLE access.governance_report ALTER COLUMN principal_id DROP NOT NULL,
    ALTER COLUMN acting_subject DROP NOT NULL, ALTER COLUMN principal_epoch DROP NOT NULL,
    ADD COLUMN content_language text,
    ADD COLUMN contact_email text,
    ADD COLUMN declarations jsonb,
    ADD COLUMN public_receipt_hash text UNIQUE,
    ADD COLUMN process text;
ALTER TABLE access.governance_report ADD CONSTRAINT governance_public_report_profile CHECK (
    public_receipt_hash IS NULL OR (public_receipt_hash ~ '^[0-9a-f]{64}$'
        AND content_language IS NOT NULL AND process IS NOT NULL));
ALTER TABLE access.governance_report ADD CONSTRAINT governance_report_actor CHECK (
    (acting_subject IS NULL) = (principal_epoch IS NULL)
    AND (acting_subject IS NULL OR principal_id IS NOT NULL));

-- Steps may originate at intake, before a decision and without an Account.
ALTER TABLE access.governance_process_step ALTER COLUMN decision_id DROP NOT NULL,
    ALTER COLUMN principal_id DROP NOT NULL,
    ADD COLUMN report_id uuid REFERENCES access.governance_report(id),
    ADD COLUMN party text CHECK (party IN ('reporter', 'affected')),
    ADD COLUMN content_language text,
    ADD COLUMN declarations jsonb;
ALTER TABLE access.governance_process_step DROP CONSTRAINT governance_process_step_process_check;
ALTER TABLE access.governance_process_step ADD CONSTRAINT governance_process_step_process_check CHECK
    (process IN ('platform_appeal', 'dmca_512', 'ordinary_dispute', 'child_safety', 'ncii',
        'credible_threat', 'platform_rules', 'realm_rules', 'privacy'));
ALTER TABLE access.governance_process_step DROP CONSTRAINT governance_process_step_step_check;
ALTER TABLE access.governance_process_step ADD CONSTRAINT governance_process_step_step_check CHECK
    (step IN ('appeal', 'uploader_notice', 'counter_notice', 'claimant_notice', 'restoration_window',
        'claimant_action', 'intake', 'message', 'removal_deadline', 'restoration_not_before',
        'restoration_not_after'));
ALTER TABLE access.governance_process_step ADD CONSTRAINT governance_public_step_basis CHECK
    (decision_id IS NOT NULL OR report_id IS NOT NULL);

CREATE TABLE access.governance_case_credential (
    id uuid PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    report_id uuid NOT NULL REFERENCES access.governance_report(id),
    party text NOT NULL CHECK (party IN ('reporter', 'affected')),
    secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (case_id, report_id) REFERENCES access.governance_report(case_id, id)
);
CREATE INDEX governance_credential_case ON access.governance_case_credential (case_id);
CREATE TRIGGER governance_credential_immutable BEFORE UPDATE OR DELETE ON access.governance_case_credential
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
-- Credential-local receipts isolate parties' retries and never store a secret.
CREATE TABLE access.governance_correspondence_receipt (
    credential_id uuid NOT NULL REFERENCES access.governance_case_credential(id),
    key_hash text NOT NULL,
    request_digest text NOT NULL,
    step_id uuid NOT NULL REFERENCES access.governance_process_step(id),
    PRIMARY KEY (credential_id, key_hash)
);
CREATE TRIGGER governance_correspondence_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.governance_correspondence_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
CREATE INDEX governance_report_own_page ON access.governance_report (principal_id, id)
    WHERE public_receipt_hash IS NOT NULL;
CREATE INDEX governance_step_report_page ON access.governance_process_step (report_id, id)
    WHERE report_id IS NOT NULL;
