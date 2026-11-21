-- Native creation establishes an empty ready baseline. Existing repair witnesses,
-- positions and public evidence still belong to the same publication.
INSERT INTO semantic.subject_page_publication(route,subject_id,readiness)
VALUES (:route::integer,:subject_id::uuid,'ready')
ON CONFLICT (route,subject_id) DO UPDATE SET readiness='ready'
RETURNING generation::text, readiness, change_position::text, completed_position::text,
public_effective_at::text, evidence, witnesses;
