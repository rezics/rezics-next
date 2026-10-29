SELECT p.author_account_id, p.thread_id, t.kind,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
WHERE p.route = :route::integer AND p.post_id = :post_id::uuid
  AND p.availability = 'available' AND p.post_id IS DISTINCT FROM t.first_post_id;
