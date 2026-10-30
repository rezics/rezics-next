SELECT owner_kind, owner_route, owner_key, present, source_version::text FROM semantic.subject_page_dependency
WHERE present AND route=:route::integer AND subject_id=:subject_id::uuid AND component_key=:component_key::text;
