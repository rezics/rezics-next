WITH page AS MATERIALIZED (
  SELECT route, watch_id
  FROM content.thread_watch
  WHERE route = :route::integer
    AND watcher_account_id = :account_id::uuid
  ORDER BY created_at, route, thread_id
  LIMIT :limit::integer
  FOR UPDATE
)
DELETE FROM content.thread_watch AS watch
USING page
WHERE (watch.route, watch.watch_id) = (page.route, page.watch_id)
RETURNING watch.watch_id;
