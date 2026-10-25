-- The immutable author/thread prefix and frozen upper bound retain erased
-- posts. One exact page receipt fences a commit before the native checkpoint;
-- it is continuation evidence only, never authority to erase another page.
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
), receipt AS MATERIALIZED (
  SELECT r.response
  FROM core.receipt r CROSS JOIN input i
  WHERE r.partition_no = :partition_no::integer
    AND r.principal_kind = 'account' AND r.principal_id = :initiator_id::uuid
    AND r.command_kind = 'content.author-erasure.page'
    AND r.idempotency_key = 'wf:' || :operation_id::text || ':erase:' || i.after_at || ':' || i.after_id::text
    AND r.response -> 'postIds' = (SELECT jsonb_agg(post_id ORDER BY created_at, post_id) FROM page)
)
SELECT p.post_id, p.created_at::text AS at,
       p.availability = 'erased' AND r.response IS NOT NULL AS committed,
       COALESCE(r.response ->> 'erasedRevisions', '0') AS erased_revisions
FROM page p LEFT JOIN receipt r ON true
ORDER BY p.created_at, p.post_id;
