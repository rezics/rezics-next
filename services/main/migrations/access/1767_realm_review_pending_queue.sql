-- A retained decision head is history, not completion. The existing projection
-- keeps incomplete effects and later correspondence waiting for Realm review.
CREATE INDEX governance_case_realm_waiting_page ON access.governance_case
    (authority_scope_id,context,opened_at,id)
    WHERE authority_kind = 'realm' AND NOT urgent AND state = 'open' AND review_pending;
CREATE INDEX governance_case_realm_waiting_kind_page ON access.governance_case
    (authority_scope_id,context,kind,opened_at,id)
    WHERE authority_kind = 'realm' AND NOT urgent AND state = 'open' AND review_pending;
CREATE INDEX governance_case_realm_decided_page ON access.governance_case
    (authority_scope_id,context,opened_at,id)
    WHERE authority_kind = 'realm' AND NOT urgent AND NOT (state = 'open' AND review_pending);
CREATE INDEX governance_case_realm_decided_kind_page ON access.governance_case
    (authority_scope_id,context,kind,opened_at,id)
    WHERE authority_kind = 'realm' AND NOT urgent AND NOT (state = 'open' AND review_pending);

CREATE OR REPLACE FUNCTION access.realm_queue_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text; family text; before_open integer := 0; after_open integer; delta integer; escalated boolean; at_time timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'governance_case' THEN
    IF NEW.authority_kind <> 'realm' OR NEW.authority_scope_id <> 'governance:realm:' || NEW.context THEN RETURN NEW; END IF;
    -- Owner recovery may refresh an unchanged projection repeatedly. Count a
    -- transition once, and leave its read fence stable when no queue fact moved.
    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state AND NEW.generation = OLD.generation
      AND NEW.decision_head IS NOT DISTINCT FROM OLD.decision_head
      AND NEW.review_pending = OLD.review_pending THEN RETURN NEW; END IF;
    r := NEW.context; family := 'report'; after_open := (NEW.state = 'open' AND NEW.review_pending)::integer;
    IF TG_OP = 'UPDATE' THEN before_open := (OLD.state = 'open' AND OLD.review_pending)::integer; END IF;
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
DROP TRIGGER realm_activity_case ON access.governance_case;
CREATE TRIGGER realm_activity_case AFTER INSERT OR UPDATE OF state,generation,decision_head,review_pending ON access.governance_case
  FOR EACH ROW EXECUTE FUNCTION access.realm_queue_activity();

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
        WHERE id = NEW.item_id AND authority_kind = 'realm' AND context = r
          AND authority_scope_id = 'governance:realm:' || r AND state = 'open' AND review_pending;
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

-- Repair retained point aggregates without changing case/effect history or
-- applying deltas against the previous head-based totals. Submission facts and
-- activity timestamps retain their existing owners.
-- Take the same revision-before-activity locks as every live activity writer.
SELECT access.advance_realm_management_read_revision(context) FROM (
  SELECT DISTINCT context FROM access.governance_case
  WHERE authority_kind = 'realm' AND authority_scope_id = 'governance:realm:' || context
  ORDER BY context
) realms;
INSERT INTO access.realm_management_activity (realm)
  SELECT DISTINCT context FROM access.governance_case
  WHERE authority_kind = 'realm' AND authority_scope_id = 'governance:realm:' || context
  ON CONFLICT DO NOTHING;
UPDATE access.realm_management_activity a SET
  open_reports = (SELECT count(*) FROM access.governance_case c WHERE c.context = a.realm
    AND c.authority_kind = 'realm' AND c.authority_scope_id = 'governance:realm:' || a.realm
    AND c.state = 'open' AND c.review_pending),
  escalated_reports = (SELECT count(*) FROM access.realm_admin_escalation e
    JOIN access.governance_case c ON c.id = e.item_id
    WHERE e.realm = a.realm AND e.item_kind = 'report' AND c.context = a.realm
      AND c.authority_kind = 'realm' AND c.authority_scope_id = 'governance:realm:' || a.realm
      AND c.state = 'open' AND c.review_pending)
  WHERE EXISTS (SELECT 1 FROM access.governance_case c WHERE c.context = a.realm
    AND c.authority_kind = 'realm' AND c.authority_scope_id = 'governance:realm:' || a.realm);
