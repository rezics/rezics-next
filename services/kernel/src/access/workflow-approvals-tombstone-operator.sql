-- Prefer the approval's recorded consumer. Ordinary delete workflows bind consumption
-- to their stable tombstone command receipt, which supplies the same transaction identity.
WITH approval AS MATERIALIZED (
  SELECT consumed_transaction_id
  FROM access.workflow_approval
  WHERE route = :approval_route AND approval_id = :approval_id
), consumed AS MATERIALIZED (
  SELECT consumed_transaction_id AS transaction_id
  FROM approval
  WHERE consumed_transaction_id IS NOT NULL
  UNION ALL
  SELECT receipt.transaction_id
  FROM core.receipt receipt
  WHERE receipt.partition_no = :partition_no
    AND receipt.principal_kind = 'account'
    AND receipt.principal_id = :actor_id
    AND receipt.command_kind = 'access.account-tombstoned'
    AND receipt.idempotency_key = :idempotency_key
    AND NOT EXISTS (SELECT 1 FROM approval WHERE consumed_transaction_id IS NOT NULL)
)
SELECT fence.prior_operator_account_id AS "priorOperatorAccountId"
FROM access.lifecycle_fence_receipt fence
JOIN consumed ON consumed.transaction_id = fence.transaction_id
WHERE fence.route = :route
  AND fence.account_id = :account_id
  AND fence.kind = 'tombstone'
  AND fence.prior_operator_account_id IS NOT NULL
LIMIT 1;
