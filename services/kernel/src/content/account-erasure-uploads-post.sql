SELECT availability, visibility FROM content.post
WHERE route = :route::integer AND post_id = :id::uuid;
