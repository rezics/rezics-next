SELECT sequence, target::text FROM semantic.redirect
WHERE route = :route::integer AND subject_id = :subject_id::uuid
ORDER BY sequence DESC LIMIT 1;
