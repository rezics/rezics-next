INSERT INTO content.subject_report_action (route, subject_id, security_revision, action_id, decided_at)
VALUES (:route::integer, :subject_id::uuid, :security_revision::bigint, :action_id::uuid, :decided_at::timestamptz)
ON CONFLICT (route, subject_id) DO UPDATE
SET security_revision = EXCLUDED.security_revision, action_id = EXCLUDED.action_id, decided_at = EXCLUDED.decided_at
WHERE subject_report_action.security_revision < EXCLUDED.security_revision;
