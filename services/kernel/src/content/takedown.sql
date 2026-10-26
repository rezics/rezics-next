-- unbound: one input route scopes the target and related review thread updates; the checker does not trace route columns through data-modifying CTEs
-- The partition executor serializes this point decision with other writes.
-- Native bigint arithmetic cannot reuse or round a previous revision.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id
), board_change AS (
  UPDATE content.board SET visibility = 'taken_down', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'board' AND content.board.route = i.route AND board_id = i.id
  RETURNING security_revision::text
), thread_change AS (
  UPDATE content.thread SET visibility = 'taken_down', security_revision = security_revision + 1,
    review_live = CASE WHEN content.thread.kind = 'review' THEN false ELSE content.thread.review_live END
  FROM input i
  WHERE i.kind = 'thread' AND content.thread.route = i.route AND thread_id = i.id
  RETURNING security_revision::text
), post_change AS (
  UPDATE content.post SET visibility = 'taken_down', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'post' AND content.post.route = i.route AND post_id = i.id
  RETURNING content.post.route, content.post.thread_id, content.post.post_id, security_revision::text
), review_post_change AS (
  UPDATE content.thread t SET review_live = false
  FROM post_change p CROSS JOIN input i
  WHERE t.route = i.route AND t.route = p.route AND t.thread_id = p.thread_id
    AND t.kind = 'review' AND t.first_post_id = p.post_id AND t.review_live
  RETURNING t.thread_id
)
SELECT security_revision FROM board_change
UNION ALL SELECT security_revision FROM thread_change
UNION ALL SELECT security_revision FROM post_change;
