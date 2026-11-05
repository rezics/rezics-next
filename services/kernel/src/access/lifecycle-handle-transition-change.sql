WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :state::text AS state, :operation_id::text AS operation_id,
         :transaction_id::uuid AS transaction_id, :reserved_until::text AS reserved_until
), changed AS (
  UPDATE access.handle_claim h
  SET state = i.state, expires_at = NULL, reserved_until = NULLIF(i.reserved_until, '')::timestamptz,
      former_until = CASE WHEN i.state = 'reserved' THEN NULLIF(i.reserved_until, '')::timestamptz ELSE NULL END,
      hold_operation_id = NULL, hold_expected_handle = NULL,
      transaction_id = i.transaction_id
  FROM input i
  WHERE h.route = i.route AND normalized_handle = :handle AND account_id = :account_id
    AND reservation_id = :reservation_id
    AND ((i.state = 'active' AND h.state = 'pending' AND hold_operation_id = i.operation_id)
      OR (i.state = 'reserved' AND h.state = 'active'))
  RETURNING h.route, h.normalized_handle, h.account_id, h.reservation_id
)
INSERT INTO access.lifecycle_handle_effect
  (route, normalized_handle, account_id, reservation_id, operation_id, effect, transaction_id)
SELECT i.route, c.normalized_handle, c.account_id, c.reservation_id, i.operation_id, i.state, i.transaction_id FROM changed c, input i
RETURNING normalized_handle;
