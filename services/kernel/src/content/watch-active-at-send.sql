SELECT watch_id
FROM content.thread_watch
WHERE route = :route::integer
  AND thread_id = :thread_id::uuid
  AND watcher_account_id = :watcher_account_id::uuid
  AND watch_id = :watch_id::uuid
  AND created_at < :published_at::timestamptz
FOR KEY SHARE;
