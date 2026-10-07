-- Previously accepted, signed public counters must not lose their recovery
-- path on upgrade. They were never delivered, so their old intake-based window
-- is not reused. Unsigned legacy authenticated steps require a signed resubmission.
WITH pending AS MATERIALIZED (
    SELECT DISTINCT ON (s.case_id, s.report_id) s.id, s.case_id, s.report_id,
        c.decision_head AS restriction_id, gen_random_uuid() AS credential_id,
        translate(encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text
            || gen_random_uuid()::text, 'UTF8')), 'base64'), '+/=', '-_') AS credential
    FROM access.governance_process_step s
    JOIN access.governance_case c ON c.id = s.case_id AND c.state = 'open'
    JOIN access.moderation_decision d ON d.id = c.decision_head
        AND d.outcome IN ('interim_restrict', 'final_restrict')
    JOIN access.rights_complaint rc ON rc.report_id = s.report_id AND rc.process = 'dmca_512'
    WHERE s.process = 'dmca_512' AND s.step = 'counter_notice' AND s.party = 'affected'
        AND s.declarations IS NOT NULL AND s.occurred_at >= d.decided_at
        AND s.declarations @> '{"goodFaithMistakeUnderPerjury":true,"consentToJurisdiction":true,"acceptService":true}'
        AND s.declarations ?& ARRAY['signature','materialLocation','name','address','phone','courtJurisdiction']
        AND NOT EXISTS (SELECT 1 FROM access.rights_counter_notice j
            WHERE j.case_id = s.case_id AND j.report_id = s.report_id AND j.restriction_id = d.id)
    ORDER BY s.case_id, s.report_id, s.occurred_at, s.id
), credentials AS (
    INSERT INTO access.governance_case_credential (id, case_id, report_id, party, secret_hash)
    SELECT credential_id, case_id, report_id, 'reporter',
        encode(sha256(convert_to(credential, 'UTF8')), 'hex') FROM pending
    RETURNING id
)
INSERT INTO access.rights_counter_notice (step_id, case_id, report_id, restriction_id, delivery_id, claimant_credential)
SELECT p.id, p.case_id, p.report_id, p.restriction_id, gen_random_uuid(), p.credential
FROM pending p JOIN credentials c ON c.id = p.credential_id;
