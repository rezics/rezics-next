-- Lock the exact active subject before deriving its next floor and fence.
-- Coordination rows do not exclude suspension. A coordinated lifecycle step
-- locks this same account and requires state = 'active', so it fails closed
-- after this update commits.
WITH target AS (
  SELECT a.ctid AS row_id, a.route, a.account_id, a.minimum_authn_epoch
  FROM access.account a
  WHERE a.route = :route::integer AND a.account_id = :account_id::uuid AND a.state = 'active'
  FOR UPDATE OF a
), fence AS (
  INSERT INTO access.lifecycle_fence_receipt
    (route, account_id, receipt_id, minimum_authn_epoch, kind, prior_operator_account_id, transaction_id)
  SELECT t.route, t.account_id, :receipt_id::uuid, t.minimum_authn_epoch + 1,
         'fence', NULL, :transaction_id::uuid
  FROM target t
  RETURNING route, account_id, receipt_id, minimum_authn_epoch, transaction_id
)
UPDATE access.account a
SET state = 'suspended', suspension_reason = NULLIF(:reason::text, ''),
    minimum_authn_epoch = f.minimum_authn_epoch,
    authn_fenced = true, fence_receipt_id = f.receipt_id, transaction_id = f.transaction_id
FROM target t JOIN fence f USING (route, account_id)
-- The row location is transaction-local and protected by target's row lock.
-- Bind the write to that exact account and observed floor as well.
WHERE a.ctid = t.row_id AND a.route = t.route AND a.account_id = t.account_id
  AND a.state = 'active' AND a.minimum_authn_epoch = t.minimum_authn_epoch
  AND f.minimum_authn_epoch = t.minimum_authn_epoch + 1
RETURNING a.minimum_authn_epoch::text AS "minimumAuthnEpoch";
