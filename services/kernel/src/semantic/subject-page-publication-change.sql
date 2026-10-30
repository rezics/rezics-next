INSERT INTO semantic.subject_page_change(route,subject_id,position,change_id,component_kind,component_key,before_state,after_state,effective_at,evidence)
VALUES (:route::integer,:subject_id::uuid,:position::bigint,:change_id::text,:kind::nullable(text),:key::nullable(text),:before::jsonb,:after::jsonb,:effective_at::nullable(timestamptz),:evidence::text)
ON CONFLICT (route,subject_id,change_id) DO NOTHING RETURNING position::text;
