-- One durable delivery/restoration job per countered notice and restriction.
CREATE TABLE access.rights_counter_notice (
    step_id uuid PRIMARY KEY REFERENCES access.governance_process_step(id),
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    report_id uuid NOT NULL,
    restriction_id uuid NOT NULL,
    delivery_id uuid NOT NULL UNIQUE,
    claimant_credential text NOT NULL CHECK (claimant_credential ~ '^[A-Za-z0-9_-]{43}$'),
    delivered_at timestamptz,
    not_before timestamptz,
    not_after timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    phase text NOT NULL DEFAULT 'delivery' CHECK (phase IN ('delivery', 'waiting', 'restoring', 'done', 'stayed')),
    restoration_id uuid REFERENCES access.moderation_decision(id),
    UNIQUE (case_id, report_id, restriction_id),
    FOREIGN KEY (case_id, report_id) REFERENCES access.governance_report(case_id, id),
    FOREIGN KEY (case_id, restriction_id) REFERENCES access.moderation_decision(case_id, id),
    CHECK ((delivered_at IS NULL) = (not_before IS NULL)),
    CHECK ((delivered_at IS NULL) = (not_after IS NULL)),
    CHECK (not_before > delivered_at AND not_before <= not_after),
    CHECK ((phase = 'delivery') = (delivered_at IS NULL))
);
CREATE INDEX rights_counter_notice_due ON access.rights_counter_notice (next_attempt_at, step_id)
    WHERE phase IN ('delivery', 'waiting', 'restoring');
CREATE INDEX rights_counter_notice_case ON access.rights_counter_notice (case_id, restriction_id, report_id);
CREATE INDEX governance_step_case_party_page ON access.governance_process_step (case_id, id);
CREATE INDEX governance_step_dmca_action ON access.governance_process_step (case_id, decision_id, report_id)
    WHERE process = 'dmca_512' AND step = 'claimant_action';

CREATE FUNCTION access.guard_rights_counter_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.step_id <> OLD.step_id OR NEW.case_id <> OLD.case_id
        OR NEW.report_id <> OLD.report_id OR NEW.restriction_id <> OLD.restriction_id
        OR NEW.delivery_id <> OLD.delivery_id OR NEW.claimant_credential <> OLD.claimant_credential THEN
        RAISE EXCEPTION 'counter-notice identity and delivery receipt are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.delivered_at IS NOT NULL AND (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
        OR NEW.not_before IS DISTINCT FROM OLD.not_before OR NEW.not_after IS DISTINCT FROM OLD.not_after) THEN
        RAISE EXCEPTION 'confirmed counter-notice deadlines cannot be reset' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER rights_counter_notice_guard BEFORE UPDATE OR DELETE ON access.rights_counter_notice
    FOR EACH ROW EXECUTE FUNCTION access.guard_rights_counter_notice();
