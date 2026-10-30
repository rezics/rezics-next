INSERT INTO semantic.subject_page_continuation(route,subject_id,kind,change_id,effective_at,evidence)
VALUES(:route::integer,:subject_id::uuid,:kind::text,:change_id::text,:effective_at::nullable(timestamptz),:evidence::text)
ON CONFLICT(route,subject_id,kind) DO UPDATE SET change_id=EXCLUDED.change_id,effective_at=EXCLUDED.effective_at,evidence=EXCLUDED.evidence
RETURNING change_id;
