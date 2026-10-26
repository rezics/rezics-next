INSERT INTO semantic.hidden_candidate
(route, subject_id, candidate_id, visibility, security_revision)
VALUES (:route::integer, :subject_id::uuid, :candidate_id::uuid, :visibility::text, :security_revision::bigint)
ON CONFLICT (route, subject_id, candidate_id)
DO UPDATE SET visibility = EXCLUDED.visibility, security_revision = EXCLUDED.security_revision;
