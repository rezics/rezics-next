SELECT post_id
FROM content.post
WHERE route = :route::integer AND deleted_at < :at::timestamptz - interval '30 days'
  AND NOT purge_completed
ORDER BY deleted_at, post_id
LIMIT 100;
