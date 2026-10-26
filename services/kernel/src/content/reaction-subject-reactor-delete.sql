DELETE FROM content.subject_reactor
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND actor_account_id = :actor_account_id::uuid;
