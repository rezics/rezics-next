-- Logical erasure returns before any physical history/media page is read.
-- Existing media terminal fences survive this decision. Collection owns its
-- pending rows; that independent irreversible cleanup must not be cancelled.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id
), post_change AS (
  UPDATE content.post SET availability = 'erased', security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'post' AND content.post.route = i.route AND post_id = i.id
    AND availability = 'available'
  RETURNING security_revision::text
), media_change AS (
  UPDATE content.media SET erased = true, security_revision = security_revision + 1
  FROM input i
  WHERE i.kind = 'media' AND content.media.route = i.route AND media_id = i.id
    AND NOT erased AND NOT collection_pending
  RETURNING security_revision::text
)
SELECT security_revision FROM post_change
UNION ALL SELECT security_revision FROM media_change;
