INSERT INTO semantic.subject_page_owner(route,owner_kind,owner_key,change_id,effective_at,evidence)
VALUES(:route::integer,:owner_kind::text,:owner_key::text,:change_id::text,:effective_at::nullable(timestamptz),:evidence::text)
ON CONFLICT(route,owner_kind,owner_key) DO UPDATE SET change_id=EXCLUDED.change_id,effective_at=EXCLUDED.effective_at,evidence=EXCLUDED.evidence
WHERE subject_page_owner.effective_at IS NULL OR EXCLUDED.effective_at >= subject_page_owner.effective_at
RETURNING change_id;
