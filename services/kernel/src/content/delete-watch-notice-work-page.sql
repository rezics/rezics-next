WITH page AS MATERIALIZED (
  SELECT route, post_id
  FROM content.thread_watch_notice_work
  WHERE route = :route::integer AND published_at < :cutoff::timestamptz
  ORDER BY published_at, post_id
  LIMIT :limit::integer
  FOR UPDATE
)
DELETE FROM content.thread_watch_notice_work AS work
USING page
WHERE (work.route, work.post_id) = (page.route, page.post_id)
RETURNING work.post_id;
