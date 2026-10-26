SELECT post_id, reply_to_post_id, head_revision_id, visibility, security_revision::text, availability
FROM content.post WHERE route = :route::integer AND post_id = :id::uuid AND thread_id = :thread_id::uuid;
