-- unbound: one input route scopes the post, related thread and media updates; the checker does not trace route columns through data-modifying CTEs
-- Logical erasure returns before any physical history/media page is read.
-- Existing media terminal fences survive this decision. Collection owns its
-- pending rows; that independent irreversible cleanup must not be cancelled.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id, :deleted_at::timestamptz AS deleted_at
), post_change AS (
  UPDATE content.post SET availability = 'erased', security_revision = security_revision + 1,
    deleted_at = COALESCE(i.deleted_at, content.post.deleted_at),
    purge_started_at = CASE WHEN i.deleted_at IS NULL AND content.post.deleted_at IS NOT NULL
      THEN COALESCE(purge_started_at, statement_timestamp()) ELSE purge_started_at END
  FROM input i
  WHERE i.kind = 'post' AND content.post.route = i.route AND post_id = i.id
    AND (availability = 'available' OR (i.deleted_at IS NULL AND content.post.deleted_at IS NOT NULL AND purge_started_at IS NULL))
  RETURNING content.post.route, content.post.thread_id, content.post.post_id, security_revision::text
), review_change AS (
  UPDATE content.thread t SET review_live = false
  FROM post_change p CROSS JOIN input i
  WHERE t.route = i.route AND t.route = p.route AND t.thread_id = p.thread_id
    AND t.kind = 'review' AND t.first_post_id = p.post_id AND t.review_live
  RETURNING t.thread_id
), media_change AS (
  UPDATE content.media SET erased = true, security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'media' AND content.media.route = i.route AND media_id = i.id
    AND NOT erased AND NOT collection_pending
  RETURNING security_revision::text
)
SELECT security_revision FROM post_change
UNION ALL SELECT security_revision FROM media_change;
