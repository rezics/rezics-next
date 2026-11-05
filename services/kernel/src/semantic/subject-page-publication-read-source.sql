SELECT owner_route,owner_key FROM semantic.subject_page_source
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND candidate_id=:candidate_id::uuid;
