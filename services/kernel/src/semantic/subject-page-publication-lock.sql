INSERT INTO semantic.subject_page_publication(route,subject_id) VALUES (:route::integer,:subject_id::uuid)
ON CONFLICT (route,subject_id) DO UPDATE SET subject_id=EXCLUDED.subject_id
RETURNING generation::text, readiness, change_position::text, completed_position::text,
public_effective_at::text, evidence, witnesses;
