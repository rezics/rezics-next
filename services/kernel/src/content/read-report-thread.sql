SELECT thread_id, board_id, first_post_id, visibility, security_revision::text, availability
FROM content.thread WHERE route = :route::integer AND thread_id = :id::uuid;
