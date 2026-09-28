-- A decided case remains open to allow another decision, including reversal.
-- The waiting queue ends at the first decision head. Keep the point aggregate
-- aligned with the moderation read's decision_head predicate.
UPDATE access.realm_management_activity a SET
  open_reports = (SELECT count(*) FROM access.governance_case c WHERE c.context = a.realm
    AND c.authority_kind = 'realm' AND c.authority_scope_id = 'governance:realm:' || a.realm
    AND c.state = 'open' AND c.decision_head IS NULL),
  escalated_reports = (SELECT count(*) FROM access.realm_admin_escalation e
    JOIN access.governance_case c ON c.id = e.item_id
    WHERE e.realm = a.realm AND e.item_kind = 'report' AND c.state = 'open'
      AND c.decision_head IS NULL);

CREATE OR REPLACE FUNCTION access.realm_queue_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text; family text; before_open integer := 0; after_open integer; delta integer; escalated boolean; at_time timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'governance_case' THEN
    IF NEW.authority_kind <> 'realm' OR NEW.authority_scope_id <> 'governance:realm:' || NEW.context THEN RETURN NEW; END IF;
    r := NEW.context; family := 'report'; after_open := (NEW.state = 'open' AND NEW.decision_head IS NULL)::integer;
    IF TG_OP = 'UPDATE' THEN before_open := (OLD.state = 'open' AND OLD.decision_head IS NULL)::integer; END IF;
    at_time := COALESCE(NEW.closed_at,NEW.opened_at);
  ELSE
    r := NEW.realm; family := 'submission'; after_open := (NEW.state IN ('pending','deciding'))::integer;
    IF TG_OP = 'UPDATE' THEN before_open := (OLD.state IN ('pending','deciding'))::integer; END IF;
    at_time := NEW.updated_at;
  END IF;
  delta := after_open - before_open;
  SELECT EXISTS (SELECT 1 FROM access.realm_admin_escalation WHERE realm = r AND item_kind = family AND item_id = NEW.id) INTO escalated;
  PERFORM access.advance_realm_activity(r,CASE WHEN family = 'report' THEN delta ELSE 0 END,
    CASE WHEN family = 'submission' THEN delta ELSE 0 END,
    CASE WHEN family = 'report' AND escalated THEN delta ELSE 0 END,
    CASE WHEN family = 'submission' AND escalated THEN delta ELSE 0 END,
    CASE WHEN family = 'report' THEN at_time END,CASE WHEN family = 'submission' THEN at_time END,NULL);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access.realm_event_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text; report_time timestamptz; submission_time timestamptz; admin_time timestamptz;
  report_delta integer := 0; submission_delta integer := 0;
BEGIN
  IF TG_TABLE_NAME = 'governance_report' THEN
    SELECT context INTO r FROM access.governance_case WHERE id = NEW.case_id AND authority_kind = 'realm'
      AND authority_scope_id = 'governance:realm:' || context;
    report_time := NEW.received_at;
  ELSIF TG_TABLE_NAME = 'moderation_decision' THEN
    IF NEW.authority_kind = 'realm' AND NEW.authority_scope_id = 'governance:realm:' || NEW.context THEN r := NEW.context; END IF;
    report_time := NEW.decided_at;
  ELSIF TG_TABLE_NAME = 'realm_admin_escalation' THEN
    r := NEW.realm;
    IF NEW.item_kind = 'report' THEN
      SELECT count(*)::integer INTO report_delta FROM access.governance_case
        WHERE id = NEW.item_id AND state = 'open' AND decision_head IS NULL;
      report_time := NEW.escalated_at;
    ELSE
      SELECT count(*)::integer INTO submission_delta FROM access.realm_submission WHERE id = NEW.item_id AND state IN ('pending','deciding');
      submission_time := NEW.escalated_at;
    END IF;
  ELSE r := NEW.realm; admin_time := NEW.created_at;
  END IF;
  IF r IS NOT NULL THEN PERFORM access.advance_realm_activity(r,0,0,report_delta,submission_delta,report_time,submission_time,admin_time); END IF;
  RETURN NEW;
END $$;
