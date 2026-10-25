SELECT receipt_id AS "receiptId", account_id AS "accountId", minimum_authn_epoch::text AS "minimumAuthnEpoch",
       kind, prior_operator_account_id AS "priorOperatorAccountId"
FROM access.lifecycle_fence_receipt
WHERE route = :route AND account_id = :account_id AND receipt_id = :receipt_id;
