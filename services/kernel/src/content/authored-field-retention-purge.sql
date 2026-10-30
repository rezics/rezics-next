UPDATE content.authored_field
SET body = NULL, availability = 'erased'
WHERE route = :route::integer AND id = :document_id::uuid
  AND subject = :subject_id::uuid AND candidate = :candidate_id::uuid
  AND revision = :revision::bigint AND availability = 'available' AND body IS NOT NULL
RETURNING id;
