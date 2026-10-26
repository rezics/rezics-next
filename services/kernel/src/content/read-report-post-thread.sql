SELECT thread_id FROM content.post WHERE route = :route::integer AND post_id = :id::uuid;
