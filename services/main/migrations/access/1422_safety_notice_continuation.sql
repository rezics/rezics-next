-- Private resumable delivery, independent of the generic notification inventory.
CREATE TABLE access.safety_notice_job (
    decision_id uuid NOT NULL REFERENCES access.moderation_decision(id),
    ordinal smallint NOT NULL,
    target jsonb NOT NULL,
    participant text,
    phase text NOT NULL DEFAULT 'graph' CHECK (phase IN ('graph','maintainer','participant','done')),
    after_subject text,
    subject text,
    after_principal uuid,
    PRIMARY KEY (decision_id,ordinal)
);
CREATE TABLE access.safety_notice_mail_cursor (
    decision_id uuid PRIMARY KEY REFERENCES access.moderation_decision(id),
    phase text NOT NULL DEFAULT 'parties' CHECK (phase IN ('parties','reporters','done')),
    after_party uuid,
    after_report_at timestamptz,
    after_report uuid
);
CREATE TABLE access.safety_notice_mail_receipt (
    delivery_id uuid PRIMARY KEY,
    decision_id uuid NOT NULL REFERENCES access.moderation_decision(id),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX safety_notice_mail_receipt_decision ON access.safety_notice_mail_receipt(decision_id);
CREATE INDEX safety_notice_pending_job ON access.safety_notice_job(decision_id,ordinal) WHERE phase <> 'done';
CREATE INDEX safety_notice_representation_page ON access.representation(subject_id,principal_id)
    WHERE active;
-- New notifying decisions always explain their outcome; legacy rows remain readable.
ALTER TABLE access.moderation_decision ADD CONSTRAINT moderation_notifying_reasons
    CHECK (case_id IS NULL OR kind NOT IN ('content_moderation','rights_disposition')
        OR statement_of_reasons IS NOT NULL) NOT VALID;
CREATE TRIGGER safety_notice_mail_receipt_immutable BEFORE UPDATE OR DELETE ON access.safety_notice_mail_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
