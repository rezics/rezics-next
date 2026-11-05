-- Lock the exact active person before deriving its next floor and fence. Unlike suspension the account stays
-- active, so Auth recovery can establish a new credential and clear exactly this fence. An already fenced person
-- is advanced again: a recovery whose proof was issued before this fence no longer matches the account's floor.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route), target AS (
  SELECT a.ctid AS row_id, a.route, a.account_id, a.minimum_authn_epoch
  FROM access.account a CROSS JOIN input i
  WHERE a.route = i.route AND a.account_id = :account_id::uuid AND a.state = 'active'
    AND a.kind = 'actor' AND a.operator_account_id IS NULL
  FOR UPDATE OF a
), fence AS (
  INSERT INTO access.lifecycle_fence_receipt
    (route, account_id, receipt_id, minimum_authn_epoch, kind, prior_operator_account_id, transaction_id)
  SELECT i.route, t.account_id, :receipt_id::uuid, t.minimum_authn_epoch + 1,
         'fence', NULL, :transaction_id::uuid
  FROM target t CROSS JOIN input i
  RETURNING route, account_id, receipt_id, minimum_authn_epoch, transaction_id
)
UPDATE access.account a
SET minimum_authn_epoch = f.minimum_authn_epoch, authn_fenced = true,
    fence_receipt_id = f.receipt_id, transaction_id = f.transaction_id
FROM target t JOIN fence f USING (route, account_id) CROSS JOIN input i
-- The row location is transaction-local and protected by target's row lock.
-- Bind the write to that exact account and observed floor as well.
WHERE a.ctid = t.row_id AND a.route = i.route AND a.account_id = t.account_id
  AND a.state = 'active' AND a.minimum_authn_epoch = t.minimum_authn_epoch
  AND f.minimum_authn_epoch = t.minimum_authn_epoch + 1
RETURNING a.minimum_authn_epoch::text AS "minimumAuthnEpoch";
