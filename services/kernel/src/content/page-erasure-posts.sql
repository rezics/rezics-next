-- Immutable author/thread prefix and frozen upper bound; no availability filter
-- may walk past the page's index neighbourhood. The exact source receipt is a
-- cleanup continuation only, never permission to erase a subsequent post.
SELECT p.post_id, p.created_at::text AS at,
       p.availability = 'erased' AND EXISTS (
         SELECT 1 FROM core.receipt r
         WHERE r.partition_no = :partition_no::integer
           AND r.principal_kind = 'account' AND r.principal_id = :initiator_id::uuid
           AND r.command_kind = 'content.post:erase'
           AND r.idempotency_key = 'wf:' || :operation_id::text || ':erase:' || p.post_id::text
           AND r.response ->> 'targetId' = p.post_id::text
       ) AS committed
FROM content.post p
WHERE p.route = :route::integer AND p.thread_id = :thread_id::uuid
  AND p.author_account_id = :author_id::uuid
  AND (p.created_at, p.post_id) > (:after_at::timestamptz, :after_id::uuid)
  AND (p.created_at, p.post_id) <= (:upper_at::timestamptz, :upper_id::uuid)
ORDER BY p.created_at, p.post_id
LIMIT 100;
