-- Section 512(g)'s clock starts at valid counter-notice intake. Sending is an
-- independent gate: a delayed claimant copy must never move either deadline.
CREATE FUNCTION access.counter_notice_business_day(received timestamptz, days integer)
RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT ((received AT TIME ZONE 'UTC') + n * interval '1 day') AT TIME ZONE 'UTC'
    FROM generate_series(1, 20) AS n
    WHERE extract(isodow FROM (received AT TIME ZONE 'UTC') + n * interval '1 day') < 6
    ORDER BY n OFFSET (days - 1) LIMIT 1
$$;

ALTER TABLE access.rights_counter_notice
    ADD COLUMN received_at timestamptz,
    DROP CONSTRAINT rights_counter_notice_check,
    DROP CONSTRAINT rights_counter_notice_check1,
    DROP CONSTRAINT rights_counter_notice_check2;
ALTER TABLE access.rights_counter_notice DISABLE TRIGGER rights_counter_notice_guard;
UPDATE access.rights_counter_notice j SET received_at = s.occurred_at,
    not_before = access.counter_notice_business_day(s.occurred_at, 10),
    not_after = access.counter_notice_business_day(s.occurred_at, 14),
    next_attempt_at = CASE WHEN j.phase IN ('waiting','restoring')
        THEN LEAST(j.next_attempt_at, access.counter_notice_business_day(s.occurred_at, 10))
        ELSE j.next_attempt_at END
FROM access.governance_process_step s WHERE s.id = j.step_id;
ALTER TABLE access.rights_counter_notice
    ALTER COLUMN received_at SET NOT NULL,
    ALTER COLUMN not_before SET NOT NULL,
    ALTER COLUMN not_after SET NOT NULL,
    ADD CONSTRAINT rights_counter_notice_receipt_window CHECK (not_before > received_at AND not_after >= not_before);
CREATE INDEX rights_counter_notice_report ON access.rights_counter_notice (report_id, restriction_id);

CREATE OR REPLACE FUNCTION access.guard_rights_counter_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.step_id <> OLD.step_id OR NEW.case_id <> OLD.case_id
        OR NEW.report_id <> OLD.report_id OR NEW.restriction_id <> OLD.restriction_id
        OR NEW.delivery_id <> OLD.delivery_id OR NEW.claimant_credential <> OLD.claimant_credential
        OR NEW.received_at IS DISTINCT FROM OLD.received_at
        OR NEW.not_before IS DISTINCT FROM OLD.not_before OR NEW.not_after IS DISTINCT FROM OLD.not_after THEN
        RAISE EXCEPTION 'counter-notice identity, receipt and deadlines are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
        RAISE EXCEPTION 'confirmed counter-notice sending receipt cannot be reset' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
ALTER TABLE access.rights_counter_notice ENABLE TRIGGER rights_counter_notice_guard;

-- Also covers upgrade recovery inserts from previously accepted signed steps.
-- One exact step read, at most 20 weekday candidates and two deadline appends.
CREATE FUNCTION access.prepare_counter_notice_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT s.occurred_at INTO NEW.received_at FROM access.governance_process_step s
    WHERE s.id = NEW.step_id AND s.case_id = NEW.case_id AND s.report_id = NEW.report_id
        AND s.process = 'dmca_512' AND s.step = 'counter_notice';
    NEW.not_before := access.counter_notice_business_day(NEW.received_at, 10);
    NEW.not_after := access.counter_notice_business_day(NEW.received_at, 14);
    RETURN NEW;
END $$;
CREATE TRIGGER rights_counter_notice_receipt BEFORE INSERT ON access.rights_counter_notice
    FOR EACH ROW EXECUTE FUNCTION access.prepare_counter_notice_receipt();

CREATE FUNCTION access.append_counter_notice_windows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO access.governance_process_step
        (id,case_id,report_id,decision_id,process,step,idempotency_key,request_digest,occurred_at,due_at)
    SELECT uuidv7(),NEW.case_id,NEW.report_id,NEW.restriction_id,'dmca_512',w.kind,
        'counter-receipt:' || NEW.step_id::text || ':' || w.kind,s.request_digest,NEW.received_at,w.due
    FROM access.governance_process_step s CROSS JOIN
        (VALUES ('restoration_not_before',NEW.not_before),('restoration_not_after',NEW.not_after)) w(kind,due)
    WHERE s.id = NEW.step_id;
    RETURN NEW;
END $$;
CREATE TRIGGER rights_counter_notice_windows AFTER INSERT ON access.rights_counter_notice
    FOR EACH ROW EXECUTE FUNCTION access.append_counter_notice_windows();

-- Preserve old timing records for audit, append the corrected effective dates.
INSERT INTO access.governance_process_step
    (id,case_id,report_id,decision_id,process,step,idempotency_key,request_digest,occurred_at,due_at)
SELECT uuidv7(),j.case_id,j.report_id,j.restriction_id,'dmca_512',w.kind,
    'counter-receipt:' || j.step_id::text || ':' || w.kind,s.request_digest,j.received_at,w.due
FROM access.rights_counter_notice j JOIN access.governance_process_step s ON s.id = j.step_id
CROSS JOIN LATERAL (VALUES ('restoration_not_before',j.not_before),('restoration_not_after',j.not_after)) w(kind,due)
WHERE NOT EXISTS (SELECT 1 FROM access.governance_process_step old
    WHERE old.case_id = j.case_id AND old.report_id = j.report_id AND old.decision_id = j.restriction_id
        AND old.step = w.kind AND old.due_at = w.due);
