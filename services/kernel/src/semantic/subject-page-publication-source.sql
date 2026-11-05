INSERT INTO semantic.subject_page_source(route,subject_id,candidate_id,owner_route,owner_key)
VALUES (:route::integer,:subject_id::uuid,:candidate_id::uuid,:owner_route::integer,:owner_key::text)
ON CONFLICT (route,subject_id,candidate_id) DO NOTHING RETURNING candidate_id::text;
