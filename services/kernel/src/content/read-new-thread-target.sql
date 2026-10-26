SELECT thread_id FROM content.thread WHERE route = :route::integer AND thread_id = :id::uuid;
