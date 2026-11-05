SELECT component_kind,component_key FROM semantic.subject_page_component
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND generation=:generation::bigint
AND shown AND component_kind<>'label' ORDER BY component_kind,component_key LIMIT 8;
