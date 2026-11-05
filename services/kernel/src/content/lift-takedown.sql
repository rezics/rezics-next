-- unbound: one input route scopes both point updates; the checker does not trace route columns through data-modifying CTEs
-- Only visibility and its security fence change. Review slots remain permanently released.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id
), thread_change AS (
  UPDATE content.thread SET visibility = 'published', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'thread' AND content.thread.route = i.route AND thread_id = i.id
    AND visibility = 'taken_down'
  RETURNING security_revision::text
), post_change AS (
  UPDATE content.post SET visibility = 'published', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'post' AND content.post.route = i.route AND post_id = i.id
    AND visibility = 'taken_down'
  RETURNING security_revision::text
)
SELECT security_revision FROM thread_change
UNION ALL SELECT security_revision FROM post_change;
