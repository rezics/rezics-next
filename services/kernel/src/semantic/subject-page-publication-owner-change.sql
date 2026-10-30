INSERT INTO semantic.subject_page_fanout(route,owner_kind,owner_key,change_id,effective_at,evidence)
VALUES(:route::integer,:owner_kind::text,:owner_key::text,:change_id::text,:effective_at::nullable(timestamptz),:evidence::text)
ON CONFLICT DO NOTHING RETURNING change_id;
