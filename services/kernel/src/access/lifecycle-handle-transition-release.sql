WITH input AS (
  SELECT :route::integer AS route, :handle::text AS handle, :account_id::uuid AS account_id,
         :reservation_id::uuid AS reservation_id, :operation_id::text AS operation_id,
         :transaction_id::uuid AS transaction_id
), restored AS (
  UPDATE access.handle_claim h
  SET state = 'reserved', expires_at = NULL, reserved_until = h.former_until,
      hold_operation_id = NULL, hold_expected_handle = NULL, transaction_id = i.transaction_id
  FROM input i
  WHERE h.route = i.route AND h.normalized_handle = i.handle AND h.account_id = i.account_id
    AND h.reservation_id = i.reservation_id AND h.hold_operation_id = i.operation_id
    AND h.state = 'pending' AND h.former_until IS NOT NULL
  RETURNING h.normalized_handle
),
released AS (
  DELETE FROM access.handle_claim h
  USING input i
  WHERE h.route = i.route AND h.normalized_handle = i.handle AND h.account_id = i.account_id
    AND h.reservation_id = i.reservation_id AND h.hold_operation_id = i.operation_id
    AND h.state = 'pending' AND h.former_until IS NULL
  RETURNING h.normalized_handle
)
SELECT normalized_handle FROM restored
UNION ALL
SELECT normalized_handle FROM released;
