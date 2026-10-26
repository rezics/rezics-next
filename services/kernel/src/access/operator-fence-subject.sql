WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
    :operator_id::uuid AS operator_id, :reservation_id::uuid AS reservation_id
)
SELECT a.account_id
FROM input i JOIN access.account a ON a.route = i.route AND a.account_id = i.subject_id
JOIN access.operator_relation_slot s ON s.route = a.route AND s.subject_account_id = a.account_id
  AND s.reservation_id = a.operator_reservation_id
WHERE a.state <> 'deleted' AND (NOT a.authn_fenced OR EXISTS (
  SELECT 1 FROM access.lifecycle_fence_receipt f
  WHERE f.route = i.route AND f.account_id = a.account_id AND f.receipt_id = a.fence_receipt_id
    AND f.operator_account_id = i.operator_id AND f.operator_reservation_id = i.reservation_id
))
  AND a.operator_account_id = i.operator_id AND a.operator_reservation_id = i.reservation_id
  AND s.operator_account_id = i.operator_id AND NOT s.terminal
FOR UPDATE OF a, s;
