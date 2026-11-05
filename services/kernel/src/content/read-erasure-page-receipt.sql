-- Exact page continuation evidence, never authority to erase another page.
SELECT r.response IS NOT NULL AS present,
       COALESCE(r.response ->> 'erasedRevisions', '0') AS erased_revisions
FROM core.receipt r
WHERE r.partition_no = :partition_no::integer
  AND r.principal_kind = 'account' AND r.principal_id = :initiator_id::uuid
  AND r.command_kind = 'content.author-erasure.page'
  AND r.idempotency_key = ANY(:idempotency_keys::text[])
  AND r.response -> 'postIds' = :post_ids::jsonb
LIMIT 1;
