SELECT visibility FROM semantic.subject WHERE route = :route::integer AND subject_id = :subject_id::uuid;
