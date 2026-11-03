SELECT route, watch_id::text, watcher_account_id::text, created_at::text
FROM content.thread_watch
WHERE thread_id = :thread_id::uuid
  AND watcher_account_id <> :actor_id::uuid
  AND created_at < :published_at::timestamptz
  AND (
    :cursor_created_at::nullable(timestamptz) IS NULL
    OR (created_at, watch_id) > (:cursor_created_at::nullable(timestamptz), :cursor_watch_id::nullable(uuid))
  )
ORDER BY created_at, watch_id
LIMIT :limit::integer;
