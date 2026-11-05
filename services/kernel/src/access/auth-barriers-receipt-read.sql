SELECT f.receipt_id AS "receiptId"
FROM access.lifecycle_fence_receipt f
JOIN core.receipt r
  ON r.partition_no = :partition_no::integer AND r.principal_kind = 'account' AND r.principal_id = :service_id::uuid
 AND r.command_kind = 'access.authentication-floor-advanced' AND r.idempotency_key = ANY(:receipt_keys::text[])
 AND r.transaction_id = f.transaction_id
WHERE f.route = :route AND f.account_id = :account_id AND f.receipt_id = :receipt_id
  AND f.minimum_authn_epoch = :minimum_authn_epoch::bigint AND f.kind = 'fence' AND f.prior_operator_account_id IS NULL
LIMIT 1;
