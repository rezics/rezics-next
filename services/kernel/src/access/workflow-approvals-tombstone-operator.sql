-- Prefer the approval's recorded consumer. Ordinary delete workflows bind consumption
-- to their stable tombstone command receipt, which supplies the same transaction identity.
-- A direct lifecycle replay supplies no approval id and resolves only its exact command receipt.
WITH approval_input AS NOT MATERIALIZED (
  SELECT :approval_route::integer AS route, :approval_id::nullable(uuid) AS approval_id
), approval AS MATERIALIZED (
  SELECT workflow.consumed_transaction_id
  FROM access.workflow_approval workflow CROSS JOIN approval_input
  WHERE approval_input.approval_id IS NOT NULL
    AND workflow.route = approval_input.route AND workflow.approval_id = approval_input.approval_id
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
    AND receipt.idempotency_key = ANY(:idempotency_keys::text[])
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
