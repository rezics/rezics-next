INSERT INTO semantic.subject_page_component(route,subject_id,component_kind,component_key,generation,shown,digest,effective_at,evidence,last_change_position,source_version)
VALUES (:route::integer,:subject_id::uuid,:kind::text,:key::text,:generation::bigint,:shown::boolean,:digest::nullable(text),:effective_at::nullable(timestamptz),:evidence::text,:position::bigint,1)
ON CONFLICT (route,subject_id,component_kind,component_key) DO UPDATE SET generation=EXCLUDED.generation,
shown=EXCLUDED.shown,digest=EXCLUDED.digest,effective_at=GREATEST(subject_page_component.effective_at,EXCLUDED.effective_at),
evidence=CASE WHEN subject_page_component.effective_at IS NOT NULL OR EXCLUDED.effective_at IS NOT NULL THEN 'known' ELSE 'missing' END,
last_change_position=EXCLUDED.last_change_position,source_version=subject_page_component.source_version+1
WHERE subject_page_component.last_change_position <= EXCLUDED.last_change_position
RETURNING source_version::text;
