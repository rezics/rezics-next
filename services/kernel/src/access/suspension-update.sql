WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
    :receipt_id::uuid AS receipt_id, :transaction_id::uuid AS transaction_id
), changed AS (
  UPDATE access.account a
  SET state = 'suspended', suspension_reason = NULLIF(:reason::text, ''),
      minimum_authn_epoch = a.minimum_authn_epoch + 1,
      authn_fenced = true, fence_receipt_id = i.receipt_id, transaction_id = i.transaction_id
  FROM input i
  WHERE a.route = i.route AND a.account_id = i.account_id AND a.state = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM access.lifecycle_coordination h
      WHERE h.route = a.route AND h.account_id = a.account_id
    )
  RETURNING a.route, a.account_id, a.minimum_authn_epoch
)
INSERT INTO access.lifecycle_fence_receipt
  (route, account_id, receipt_id, minimum_authn_epoch, kind, prior_operator_account_id, transaction_id)
SELECT c.route, c.account_id, i.receipt_id, c.minimum_authn_epoch, 'fence', NULL, i.transaction_id
FROM changed c CROSS JOIN input i
RETURNING minimum_authn_epoch::text AS "minimumAuthnEpoch";
