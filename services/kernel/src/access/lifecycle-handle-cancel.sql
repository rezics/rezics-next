WITH input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :operation_id::text AS operation_id,
         :handle::text AS handle, :reservation_id::uuid AS reservation_id,
         NULLIF(:expected_handle::text, '') AS expected_handle, :transaction_id::uuid AS transaction_id
)
INSERT INTO access.lifecycle_handle_operation
  (route, account_id, operation_id, handle, reservation_id, expected_handle, state, transaction_id)
SELECT i.route, i.account_id, i.operation_id, i.handle, i.reservation_id, i.expected_handle, 'cancelled', i.transaction_id
FROM access.account a, input i
WHERE a.route = i.route AND a.account_id = i.account_id AND a.handle IS DISTINCT FROM i.handle
  AND a.handle_operation_id IS DISTINCT FROM i.operation_id
ON CONFLICT (route, account_id, operation_id) DO NOTHING
RETURNING operation_id;
