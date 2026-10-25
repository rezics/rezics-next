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
  UPDATE content.thread SET visibility = 'taken_down', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'thread' AND content.thread.route = i.route AND thread_id = i.id
  RETURNING security_revision::text
), post_change AS (
  UPDATE content.post SET visibility = 'taken_down', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'post' AND content.post.route = i.route AND post_id = i.id
  RETURNING security_revision::text
)
SELECT security_revision FROM board_change
UNION ALL SELECT security_revision FROM thread_change
UNION ALL SELECT security_revision FROM post_change;
