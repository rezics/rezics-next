-- Queue counts and activity are maintained by their Access write owners. Reads
-- do one point lookup per Realm, independent of the size of its closed history.
CREATE TABLE access.realm_management_activity (
  realm text PRIMARY KEY,
  open_reports bigint NOT NULL DEFAULT 0 CHECK (open_reports >= 0),
  open_submissions bigint NOT NULL DEFAULT 0 CHECK (open_submissions >= 0),
  escalated_reports bigint NOT NULL DEFAULT 0 CHECK (escalated_reports >= 0),
  escalated_submissions bigint NOT NULL DEFAULT 0 CHECK (escalated_submissions >= 0),
  report_activity timestamptz,
  submission_activity timestamptz,
  admin_activity timestamptz
);
INSERT INTO access.realm_management_activity (realm)
SELECT context FROM access.governance_case WHERE authority_kind = 'realm'
UNION SELECT realm FROM access.realm_submission
UNION SELECT realm FROM access.realm_admin_receipt;
UPDATE access.realm_management_activity a SET
  open_reports = (SELECT count(*) FROM access.governance_case c WHERE c.context = a.realm
    AND c.authority_kind = 'realm' AND c.authority_scope_id = 'governance:realm:' || a.realm AND c.state = 'open'),
  open_submissions = (SELECT count(*) FROM access.realm_submission s WHERE s.realm = a.realm AND s.state IN ('pending','deciding')),
  escalated_reports = (SELECT count(*) FROM access.realm_admin_escalation e JOIN access.governance_case c ON c.id = e.item_id
    WHERE e.realm = a.realm AND e.item_kind = 'report' AND c.state = 'open'),
  escalated_submissions = (SELECT count(*) FROM access.realm_admin_escalation e JOIN access.realm_submission s ON s.id = e.item_id
    WHERE e.realm = a.realm AND e.item_kind = 'submission' AND s.state IN ('pending','deciding')),
  report_activity = GREATEST(
    (SELECT max(c.opened_at) FROM access.governance_case c WHERE c.context = a.realm AND c.authority_kind = 'realm'),
    (SELECT max(r.received_at) FROM access.governance_report r JOIN access.governance_case c ON c.id = r.case_id
      WHERE c.context = a.realm AND c.authority_kind = 'realm'),
    (SELECT max(d.decided_at) FROM access.moderation_decision d WHERE d.context = a.realm AND d.authority_kind = 'realm')),
  submission_activity = (SELECT max(s.updated_at) FROM access.realm_submission s WHERE s.realm = a.realm),
  admin_activity = (SELECT max(r.created_at) FROM access.realm_admin_receipt r WHERE r.realm = a.realm);

CREATE FUNCTION access.advance_realm_activity(r text, reports bigint, submissions bigint,
  report_escalations bigint, submission_escalations bigint, report_time timestamptz,
  submission_time timestamptz, admin_time timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Match the existing read-revision writer's lock order on every path.
  PERFORM access.advance_realm_management_read_revision(r);
  INSERT INTO access.realm_management_activity (realm) VALUES (r) ON CONFLICT DO NOTHING;
  UPDATE access.realm_management_activity SET
    open_reports = access.realm_management_activity.open_reports + reports,
    open_submissions = access.realm_management_activity.open_submissions + submissions,
    escalated_reports = access.realm_management_activity.escalated_reports + report_escalations,
    escalated_submissions = access.realm_management_activity.escalated_submissions + submission_escalations,
    report_activity = GREATEST(access.realm_management_activity.report_activity,report_time),
    submission_activity = GREATEST(access.realm_management_activity.submission_activity,submission_time),
    admin_activity = GREATEST(access.realm_management_activity.admin_activity,admin_time) WHERE realm = r;
END $$;

CREATE FUNCTION access.realm_queue_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text; family text; before_open integer := 0; after_open integer; delta integer; escalated boolean; at_time timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'governance_case' THEN
    IF NEW.authority_kind <> 'realm' OR NEW.authority_scope_id <> 'governance:realm:' || NEW.context THEN RETURN NEW; END IF;
    r := NEW.context; family := 'report'; after_open := (NEW.state = 'open')::integer;
    IF TG_OP = 'UPDATE' THEN before_open := (OLD.state = 'open')::integer; END IF;
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
CREATE TRIGGER realm_activity_case AFTER INSERT OR UPDATE OF state,generation,decision_head ON access.governance_case
  FOR EACH ROW EXECUTE FUNCTION access.realm_queue_activity();
CREATE TRIGGER realm_activity_submission AFTER INSERT OR UPDATE ON access.realm_submission
  FOR EACH ROW EXECUTE FUNCTION access.realm_queue_activity();

CREATE FUNCTION access.realm_event_activity() RETURNS trigger LANGUAGE plpgsql AS $$
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
      SELECT count(*)::integer INTO report_delta FROM access.governance_case WHERE id = NEW.item_id AND state = 'open';
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
CREATE TRIGGER realm_activity_report AFTER INSERT ON access.governance_report FOR EACH ROW EXECUTE FUNCTION access.realm_event_activity();
CREATE TRIGGER realm_activity_decision AFTER INSERT ON access.moderation_decision FOR EACH ROW EXECUTE FUNCTION access.realm_event_activity();
CREATE TRIGGER realm_activity_escalation AFTER INSERT ON access.realm_admin_escalation FOR EACH ROW EXECUTE FUNCTION access.realm_event_activity();
CREATE TRIGGER realm_activity_admin AFTER INSERT ON access.realm_admin_receipt FOR EACH ROW EXECUTE FUNCTION access.realm_event_activity();

CREATE FUNCTION access.retire_realm_roster_episode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'realm' AND (NEW.state <> 'joined' OR NEW.generation <> OLD.generation) THEN
    UPDATE access.realm_roster_listing SET listed = false,featured = false,changed_at = clock_timestamp()
    WHERE membership_id = NEW.id AND membership_generation = OLD.generation;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER realm_roster_episode AFTER UPDATE ON access.membership FOR EACH ROW EXECUTE FUNCTION access.retire_realm_roster_episode();
