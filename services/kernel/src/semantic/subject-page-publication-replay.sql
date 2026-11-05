SELECT position::text,change_id,component_kind,component_key,before_state,after_state,effective_at::text,evidence
FROM semantic.subject_page_change WHERE route=:route::integer AND subject_id=:subject_id::uuid AND position>:after::bigint ORDER BY position LIMIT :limit::integer;
