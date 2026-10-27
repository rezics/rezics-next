DELETE FROM semantic.redirect
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
