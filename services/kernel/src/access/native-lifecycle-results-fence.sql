SELECT receipt_id
FROM access.lifecycle_fence_receipt
WHERE route=:route AND account_id=:account_id::uuid AND receipt_id=:receipt_id::uuid
  AND transaction_id=:transaction_id::uuid AND minimum_authn_epoch=:minimum_authn_epoch::bigint
  AND kind='fence' AND prior_operator_account_id IS NULL;
