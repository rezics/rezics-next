INSERT INTO semantic.subject_page_dependency(route,subject_id,owner_kind,owner_route,owner_key,component_key,source_version,present,event_id)
VALUES (:route::integer,:subject_id::uuid,:owner_kind::text,:owner_route::integer,:owner_key::text,:component_key::text,:version::bigint,:present::boolean,:event_id::text)
ON CONFLICT(route,subject_id,owner_kind,owner_route,owner_key,component_key) DO UPDATE SET
source_version=EXCLUDED.source_version,present=EXCLUDED.present,event_id=EXCLUDED.event_id
WHERE subject_page_dependency.source_version < EXCLUDED.source_version RETURNING component_key;
