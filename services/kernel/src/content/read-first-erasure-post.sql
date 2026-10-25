-- Two prefix seeks, independent of author history cardinality. Preserve the
-- database's timestamp precision when freezing the upper tuple.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id,
         :author_id::uuid AS author_id, :at::timestamptz AS at
), first_post AS MATERIALIZED (
  SELECT post_id
  FROM content.post p CROSS JOIN input i
  WHERE p.route = i.route AND p.thread_id = i.thread_id
    AND p.author_account_id = i.author_id AND p.created_at <= i.at
  ORDER BY created_at, post_id
  LIMIT 1
)
SELECT first_post.post_id, upper_post.post_id AS upper_post_id,
       upper_post.created_at::text AS upper_created_at
FROM first_post
CROSS JOIN LATERAL (
  SELECT post_id, created_at
  FROM content.post p CROSS JOIN input i
  WHERE p.route = i.route AND p.thread_id = i.thread_id
    AND p.author_account_id = i.author_id AND p.created_at <= i.at
  ORDER BY created_at DESC, post_id DESC
  LIMIT 1
) upper_post;
