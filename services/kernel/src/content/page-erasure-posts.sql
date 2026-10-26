-- The immutable author/thread prefix and frozen upper bound retain erased
-- posts. Read the exact page receipt separately in the same snapshot.
WITH input AS NOT MATERIALIZED (
  SELECT :after_at::text AS after_at, :after_id::uuid AS after_id
), page AS MATERIALIZED (
  SELECT p.post_id, p.created_at, p.availability
  FROM content.post p CROSS JOIN input i
  WHERE p.route = :route::integer AND p.thread_id = :thread_id::uuid
    AND p.author_account_id = :author_id::uuid
    AND (p.created_at, p.post_id) > (i.after_at::timestamptz, i.after_id)
    AND (p.created_at, p.post_id) <= (:upper_at::timestamptz, :upper_id::uuid)
  ORDER BY p.created_at, p.post_id
  LIMIT 100
)
SELECT p.post_id, p.created_at::text AS at, p.availability
FROM page p
ORDER BY p.created_at, p.post_id;
