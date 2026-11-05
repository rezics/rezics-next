SELECT availability, deleted_at::text, purge_started_at::text FROM content.post WHERE route = :route::integer AND post_id = :post_id::uuid;
