ALTER TABLE access.moderation_decision ADD COLUMN statement_of_reasons jsonb;
ALTER TABLE access.moderation_decision_target ADD COLUMN expires_at timestamptz,
    ADD COLUMN participant_subject text;
ALTER TABLE access.governance_enforcement ADD COLUMN expires_at timestamptz,
    ADD COLUMN participant_subject text;
CREATE INDEX safety_participation_fence ON access.governance_enforcement (participant_subject,expires_at)
    WHERE state = 'restricted' AND effect IN ('participation','capability');
CREATE TABLE access.safety_decision_operation (
    decision_id uuid PRIMARY KEY REFERENCES access.moderation_decision(id),
    cancelled boolean NOT NULL DEFAULT false
);
CREATE TABLE access.safety_decision_effect (
    decision_id uuid NOT NULL REFERENCES access.safety_decision_operation(decision_id),
    ordinal smallint NOT NULL,
    plan jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('confirmed','pending','uncertain','failed')),
    receipt text,
    continuation text,
    error text,
    PRIMARY KEY (decision_id,ordinal),
    FOREIGN KEY (decision_id,ordinal) REFERENCES access.moderation_decision_target(decision_id,ordinal),
    CHECK (state <> 'confirmed' OR (receipt IS NOT NULL AND continuation IS NULL))
);
CREATE FUNCTION access.guard_safety_effect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.decision_id <> OLD.decision_id OR NEW.ordinal <> OLD.ordinal
       OR NEW.plan <> OLD.plan OR (OLD.state = 'confirmed' AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'effect plan and confirmation are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER safety_effect_guard BEFORE UPDATE OR DELETE ON access.safety_decision_effect
    FOR EACH ROW EXECUTE FUNCTION access.guard_safety_effect();
CREATE FUNCTION access.guard_safety_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.decision_id <> OLD.decision_id OR (OLD.cancelled AND NOT NEW.cancelled) THEN
        RAISE EXCEPTION 'cancellation cannot undo or resume an operation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER safety_operation_guard BEFORE UPDATE OR DELETE ON access.safety_decision_operation
    FOR EACH ROW EXECUTE FUNCTION access.guard_safety_operation();
CREATE FUNCTION access.project_governance_review_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.review_pending := NEW.state = 'open' AND (NEW.decision_head IS NULL OR EXISTS (
        SELECT 1 FROM access.safety_decision_operation op WHERE op.decision_id = NEW.decision_head
        AND (op.cancelled OR EXISTS (SELECT 1 FROM access.safety_decision_effect e
             WHERE e.decision_id = op.decision_id AND e.state <> 'confirmed'))
    ) OR EXISTS (
        SELECT 1 FROM access.moderation_decision d WHERE d.id = NEW.decision_head
        AND (EXISTS (SELECT 1 FROM access.governance_report r WHERE r.case_id = NEW.id AND r.received_at > d.decided_at)
          OR EXISTS (SELECT 1 FROM access.governance_process_step s WHERE s.case_id = NEW.id
            AND s.step IN ('appeal','counter_notice') AND s.recorded_at > d.decided_at))
    ));
    RETURN NEW;
END $$;
CREATE TRIGGER governance_review_pending BEFORE INSERT OR UPDATE ON access.governance_case
    FOR EACH ROW EXECUTE FUNCTION access.project_governance_review_pending();
UPDATE access.governance_case SET review_pending = review_pending;
CREATE FUNCTION access.refresh_safety_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE access.governance_case SET review_pending = review_pending WHERE id = NEW.case_id;
    RETURN NEW;
END $$;
CREATE TRIGGER safety_report_review AFTER INSERT ON access.governance_report
    FOR EACH ROW EXECUTE FUNCTION access.refresh_safety_review();
CREATE TRIGGER safety_correspondence_review AFTER INSERT ON access.governance_process_step
    FOR EACH ROW EXECUTE FUNCTION access.refresh_safety_review();
