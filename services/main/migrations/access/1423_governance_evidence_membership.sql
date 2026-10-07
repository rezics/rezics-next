-- Equality keys avoid wide indexes and case-wide evidence enumeration. Each
-- retained item contributes exact-revision and component membership.
CREATE FUNCTION access.governance_target_key(owner text, resource text, component text,
    locator text, revision text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT encode(sha256(convert_to(jsonb_build_array(owner,resource,component,locator,revision)::text,'UTF8')),'hex')
$$;
CREATE TABLE access.governance_case_evidence (
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    target_key text NOT NULL,
    available boolean NOT NULL,
    automated boolean NOT NULL,
    PRIMARY KEY (case_id,target_key,available)
);
CREATE INDEX governance_case_automated ON access.governance_case_evidence(case_id) WHERE automated;
CREATE INDEX governance_report_evidence_basis ON access.governance_report(case_id,evidence_digest);
CREATE INDEX governance_report_process ON access.governance_report(case_id,process);
CREATE INDEX rights_complaint_process ON access.rights_complaint(case_id,process);
CREATE FUNCTION access.index_governance_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained_case_id uuid;
BEGIN
    SELECT r.case_id INTO STRICT retained_case_id FROM access.governance_report r WHERE r.id = NEW.report_id;
    INSERT INTO access.governance_case_evidence AS retained
    SELECT DISTINCT retained_case_id,access.governance_target_key(NEW.owner,NEW.resource,NEW.component,NEW.locator,v.revision),
      NEW.state = 'available',NEW.provenance ? 'automation'
    FROM (VALUES (NEW.revision),(NULL::text)) v(revision)
    ON CONFLICT (case_id,target_key,available) DO UPDATE SET automated = retained.automated OR EXCLUDED.automated;
    RETURN NEW;
END $$;
INSERT INTO access.governance_case_evidence
SELECT r.case_id,access.governance_target_key(e.owner,e.resource,e.component,e.locator,v.revision),
    e.state = 'available',bool_or(e.provenance ? 'automation')
FROM access.governance_evidence e JOIN access.governance_report r ON r.id = e.report_id
CROSS JOIN LATERAL (VALUES (e.revision),(NULL::text)) v(revision)
GROUP BY r.case_id,access.governance_target_key(e.owner,e.resource,e.component,e.locator,v.revision),e.state = 'available';
CREATE TRIGGER governance_evidence_membership AFTER INSERT ON access.governance_evidence
    FOR EACH ROW EXECUTE FUNCTION access.index_governance_evidence();
