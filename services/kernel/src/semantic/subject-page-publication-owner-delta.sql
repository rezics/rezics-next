INSERT INTO semantic.subject_page_owner_dependency(route,owner_kind,owner_key,source_route,source_subject_id,component_key,source_version,present,event_id,effective_at,evidence)
VALUES(:route::integer,:owner_kind::text,:owner_key::text,:source_route::integer,:subject_id::uuid,:component_key::text,:version::bigint,:present::boolean,:event_id::text,:effective_at::nullable(timestamptz),:evidence::text)
ON CONFLICT(route,owner_kind,owner_key,source_route,source_subject_id,component_key) DO UPDATE SET
source_version=EXCLUDED.source_version,present=EXCLUDED.present,event_id=EXCLUDED.event_id,effective_at=EXCLUDED.effective_at,evidence=EXCLUDED.evidence
WHERE subject_page_owner_dependency.source_version < EXCLUDED.source_version RETURNING event_id;
