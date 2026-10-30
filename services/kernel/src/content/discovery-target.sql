SELECT thread_id, first_post_id
FROM content.thread
WHERE route = :route::integer AND thread_id = :thread_id::uuid;
