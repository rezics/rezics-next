UPDATE semantic.subject SET projection_pending = false
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
