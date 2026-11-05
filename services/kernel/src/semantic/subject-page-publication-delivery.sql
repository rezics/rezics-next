INSERT INTO semantic.subject_page_delivery(route,subject_id,owner_kind,owner_route,owner_key,change_id,event_id,effective_at,evidence)
VALUES(:route::integer,:subject_id::uuid,:owner_kind::text,:owner_route::integer,:owner_key::text,:change_id::text,:event_id::text,:effective_at::nullable(timestamptz),:evidence::text)
ON CONFLICT DO NOTHING RETURNING event_id;
