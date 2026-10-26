-- The exact suspension receipt identifies one root, regardless of older history.
SELECT continuation_id AS "continuationId", command_key_prefix AS "commandKeyPrefix"
FROM access.committed_continuation
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND barrier_receipt_id = :receipt_id::uuid
  AND allowlist @> '[{"step":"operator-responsibility-page"}]'::jsonb;
