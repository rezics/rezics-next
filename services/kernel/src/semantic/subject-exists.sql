SELECT 1 AS found
FROM semantic.subject
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
