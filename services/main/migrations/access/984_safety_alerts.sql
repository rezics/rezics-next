-- One durable source record per deadline, case generation and responder.
-- Notification intake and its existing delivery/attempt rows own delivery results.
CREATE TABLE access.safety_alert (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    step_id uuid NOT NULL,
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    case_generation bigint NOT NULL CHECK (case_generation >= 0),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    responder text NOT NULL CHECK (responder IN ('primary', 'backup')),
    reason text NOT NULL CHECK (reason IN ('approaching', 'unacknowledged', 'overdue')),
    due_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'cancelled')),
    item_id uuid REFERENCES access.notification_item(id),
    queued_at timestamptz,
    UNIQUE (step_id, case_generation, responder, principal_id),
    FOREIGN KEY (case_id, step_id) REFERENCES access.governance_process_step(case_id, id),
    CHECK ((state = 'queued') = (item_id IS NOT NULL)),
    CHECK ((state = 'queued') = (queued_at IS NOT NULL)),
    CHECK (reason <> 'approaching' OR responder = 'primary'),
    CHECK (reason <> 'unacknowledged' OR responder = 'backup')
);
CREATE INDEX safety_alert_pending ON access.safety_alert (created_at, id) WHERE state = 'pending';

CREATE FUNCTION access.guard_safety_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.state <> 'pending'
      OR (NEW.id, NEW.step_id, NEW.case_id, NEW.case_generation, NEW.principal_id,
          NEW.responder, NEW.reason, NEW.due_at, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.step_id, OLD.case_id, OLD.case_generation, OLD.principal_id,
          OLD.responder, OLD.reason, OLD.due_at, OLD.created_at) THEN
        RAISE EXCEPTION 'safety alert identity and queued intake are final' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER safety_alert_guard BEFORE UPDATE OR DELETE ON access.safety_alert
    FOR EACH ROW EXECUTE FUNCTION access.guard_safety_alert();

-- Operator audit: an inbox intake is never represented as successful external delivery.
CREATE VIEW access.safety_alert_delivery AS
SELECT a.id AS alert_id, a.case_id, a.step_id, a.case_generation, a.principal_id,
    p.account_issuer, p.account_subject, a.responder, a.reason, a.due_at,
    a.created_at, a.state AS intake_state, a.queued_at, a.item_id,
    d.id AS delivery_id, d.channel, d.state AS delivery_state,
    d.attempt_count, d.provider_message_id, d.diagnostic, d.cancel_reason, d.terminal_at
FROM access.safety_alert a JOIN access.principal p ON p.id = a.principal_id
LEFT JOIN access.notification_delivery d ON d.item_id = a.item_id;
