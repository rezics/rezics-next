UPDATE semantic.subject SET projection_pending = true
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
