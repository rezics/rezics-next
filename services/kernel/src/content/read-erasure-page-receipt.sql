-- Exact page continuation evidence, never authority to erase another page.
WITH input AS NOT MATERIALIZED (
  SELECT :after_at::text AS after_at, :after_id::uuid AS after_id
)
SELECT r.response IS NOT NULL AS present,
       COALESCE(r.response ->> 'erasedRevisions', '0') AS erased_revisions
FROM core.receipt r CROSS JOIN input i
WHERE r.partition_no = :partition_no::integer
  AND r.principal_kind = 'account' AND r.principal_id = :initiator_id::uuid
  AND r.command_kind = 'content.author-erasure.page'
  AND r.idempotency_key = 'wf:' || :operation_id::text || ':erase:' || i.after_at || ':' || i.after_id::text
  AND r.response -> 'postIds' = :post_ids::jsonb;
