SELECT purge_started_at::text, purge_completed FROM content.post
WHERE route = :route::integer AND post_id = :post_id::uuid AND availability = 'erased';
