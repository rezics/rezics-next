WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :previous_floor::bigint AS previous_floor, :transaction_id::uuid AS transaction_id), changed AS (
 UPDATE access.account
 SET minimum_authn_epoch = minimum_authn_epoch + 1, transaction_id = i.transaction_id
 FROM input i
 WHERE access.account.route = i.route AND account_id = :account_id AND kind = 'actor' AND state = 'active'
   AND minimum_authn_epoch = i.previous_floor AND authn_fenced = :fenced
 RETURNING access.account.route, account_id, minimum_authn_epoch, authn_fenced
)
INSERT INTO access.credential_floor_receipt
 (route, account_id, opening_receipt_id, receipt_id, operation_key, effect_reference, effect_digest,
  purpose, previous_floor, minimum_authn_epoch, fenced, transaction_id)
SELECT i.route, c.account_id, :opening_receipt_id, :receipt_id, :operation_key, :effect_reference, :effect_digest,
 :purpose, i.previous_floor, c.minimum_authn_epoch, c.authn_fenced, i.transaction_id
FROM changed c CROSS JOIN input i
RETURNING receipt_id AS "receiptId";
