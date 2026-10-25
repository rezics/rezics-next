UPDATE access.account
SET authn_fenced = false, transaction_id = :transaction_id
WHERE route = :route AND account_id = :account_id AND state = 'active' AND authn_fenced
  AND fence_receipt_id = :receipt_id AND minimum_authn_epoch = :minimum_authn_epoch
  AND minimum_authn_epoch <= :authn_epoch
RETURNING account_id;
