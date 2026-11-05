-- Lock the current relation and account. The exact native command receipt proves
-- that this suspension's child, under this reservation, raised the current fence.
WITH input AS NOT MATERIALIZED (SELECT :operator_id::uuid AS operator_id)
SELECT a.fence_receipt_id AS "fenceReceiptId", a.minimum_authn_epoch::text AS "minimumAuthnEpoch"
FROM access.account a CROSS JOIN input i
JOIN access.operator_relation_slot s ON s.route = a.route AND s.subject_account_id = a.account_id
  AND s.reservation_id = a.operator_reservation_id
JOIN access.lifecycle_fence_receipt f ON f.route = a.route AND f.account_id = a.account_id
  AND f.receipt_id = a.fence_receipt_id AND f.operator_account_id = i.operator_id
  AND f.operator_reservation_id = a.operator_reservation_id
  AND f.operator_continuation_id = :source_id::uuid
WHERE a.route = :route::integer AND a.account_id = :subject_id::uuid
  AND a.state = 'active' AND a.authn_fenced
  AND a.operator_account_id = i.operator_id AND a.operator_reservation_id = :reservation_id::uuid
  AND s.operator_account_id = i.operator_id AND NOT s.terminal
FOR UPDATE OF a, s;
