SELECT source_route,source_subject_id::text,component_key FROM semantic.subject_page_owner_dependency
WHERE present AND route=:route::integer AND owner_kind=:owner_kind::text AND owner_key=:owner_key::text
AND (source_route,source_subject_id,component_key) > (:after_route::integer,:after_subject::uuid,:after_component::text)
ORDER BY source_route,source_subject_id,component_key LIMIT :limit::integer;
