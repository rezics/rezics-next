WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :receipt_id::uuid AS receipt_id,
    :transaction_id::uuid AS transaction_id, :expected_floor::bigint AS expected_floor, :purpose::text AS purpose
), changed AS (
  UPDATE access.account a
  SET minimum_authn_epoch = minimum_authn_epoch + 1, authn_fenced = true,
      fence_receipt_id = CASE WHEN a.authn_fenced AND i.purpose = 'consent-reduction'
        THEN a.fence_receipt_id ELSE i.receipt_id END,
      transaction_id = i.transaction_id
  FROM input i
  WHERE a.route = i.route AND a.account_id = i.account_id
    AND a.minimum_authn_epoch = i.expected_floor
    AND a.state = 'active' AND a.kind = 'actor'
    AND (i.purpose = 'consent-reduction'
      OR (i.purpose = 'recovery' AND a.operator_account_id IS NULL AND a.authn_fenced))
  RETURNING a.route, a.account_id, a.minimum_authn_epoch
)
INSERT INTO access.lifecycle_fence_receipt
  (route, account_id, receipt_id, minimum_authn_epoch, kind, prior_operator_account_id, transaction_id)
SELECT i.route, c.account_id, i.receipt_id, c.minimum_authn_epoch, 'fence', NULL, i.transaction_id
FROM changed c CROSS JOIN input i
RETURNING receipt_id AS "receiptId", account_id AS "accountId", minimum_authn_epoch::text AS "minimumAuthnEpoch",
  kind, prior_operator_account_id AS "priorOperatorAccountId";
