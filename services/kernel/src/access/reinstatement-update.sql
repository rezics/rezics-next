-- Lock the exact suspended account and restore it to active. The authentication
-- floor and fence receipt stay so lifecycle-fence-clear.sql can lower only the
-- fence this suspension raised. A deleted, pending, active, or unfenced row
-- matches nothing. This statement does not read coordination, operator, or
-- history rows.
WITH target AS (
  SELECT a.ctid AS row_id, a.route, a.account_id, a.minimum_authn_epoch, a.fence_receipt_id
  FROM access.account a
  WHERE a.route = :route::integer AND a.account_id = :account_id::uuid AND a.state = 'suspended'
    AND a.authn_fenced AND a.fence_receipt_id IS NOT NULL
  FOR UPDATE OF a
)
UPDATE access.account a
SET state = 'active', suspension_reason = NULL, transaction_id = :transaction_id::uuid
FROM target t
WHERE a.ctid = t.row_id AND a.route = t.route AND a.account_id = t.account_id
  AND a.state = 'suspended' AND a.authn_fenced AND a.fence_receipt_id = t.fence_receipt_id
  AND a.minimum_authn_epoch = t.minimum_authn_epoch
RETURNING a.minimum_authn_epoch::text AS "minimumAuthnEpoch", a.fence_receipt_id AS "fenceReceiptId";
