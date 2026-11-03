WITH input AS (
  SELECT
    :thread_id::uuid AS thread_id,
    :actor_id::uuid AS actor_id,
    :published_at::timestamptz AS published_at,
    :cursor_created_at::nullable(timestamptz) AS cursor_created_at,
    :cursor_watch_id::nullable(uuid) AS cursor_watch_id,
    :limit::integer AS page_limit
)
SELECT watch.route, watch.watch_id::text, watch.watcher_account_id::text, watch.created_at::text
FROM content.thread_watch AS watch
JOIN input ON watch.thread_id = input.thread_id
WHERE watch.watcher_account_id <> input.actor_id
  AND watch.created_at < input.published_at
  AND (
    input.cursor_created_at IS NULL
    OR (watch.created_at, watch.watch_id) > (input.cursor_created_at, input.cursor_watch_id)
  )
ORDER BY watch.created_at, watch.watch_id
LIMIT (SELECT page_limit FROM input);
