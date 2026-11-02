WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :post_ids::uuid[] AS post_ids
), revision_counts AS MATERIALIZED (
  SELECT revision.post_id, count(*)::text AS revisions
  FROM content.revision AS revision
  CROSS JOIN input
  WHERE revision.route = input.route
    AND revision.post_id = ANY (input.post_ids)
  GROUP BY revision.post_id
), post_change AS (
  UPDATE content.post AS post
  SET availability = 'erased',
      security_revision = post.security_revision + 1,
      purge_started_at = CASE
        WHEN post.deleted_at IS NOT NULL AND post.purge_started_at IS NULL THEN statement_timestamp()
        ELSE post.purge_started_at
      END
  FROM input
  WHERE post.route = input.route
    AND post.post_id = ANY (input.post_ids)
    AND (
      post.availability = 'available'
      OR (post.deleted_at IS NOT NULL AND post.purge_started_at IS NULL)
    )
  RETURNING post.route, post.thread_id, post.post_id, post.security_revision::text AS security_revision
), review_change AS (
  UPDATE content.thread AS thread
  SET review_live = false
  FROM post_change AS post
  WHERE thread.route = post.route
    AND thread.thread_id = post.thread_id
    AND thread.kind = 'review'
    AND thread.first_post_id = post.post_id
    AND thread.review_live
  RETURNING thread.thread_id
)
SELECT
  post.post_id::text AS "postId",
  post.security_revision AS "securityRevision",
  COALESCE(revision_counts.revisions, '0') AS revisions
FROM post_change AS post
CROSS JOIN input
LEFT JOIN revision_counts ON revision_counts.post_id = post.post_id
ORDER BY array_position(input.post_ids, post.post_id);
