UPDATE semantic.subject
SET current_release = :release::text
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
