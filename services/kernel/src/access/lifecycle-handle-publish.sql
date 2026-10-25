WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :operation_id::text AS operation_id,
         :handle::text AS handle, :reservation_id::uuid AS reservation_id,
         NULLIF(:expected_handle::text, '') AS expected_handle,
         NULLIF(:old_reservation_id::text, '')::uuid AS old_reservation_id, :transaction_id::uuid AS transaction_id
), operation AS (
  INSERT INTO access.lifecycle_handle_operation
    (route, account_id, operation_id, handle, reservation_id, expected_handle, old_reservation_id, state, transaction_id)
  SELECT i.route, i.account_id, i.operation_id, i.handle, i.reservation_id,
         i.expected_handle, i.old_reservation_id, 'published', i.transaction_id
  FROM input i, access.account a
  WHERE a.route = i.route AND a.account_id = i.account_id AND a.state = 'active' AND NOT a.authn_fenced
    AND a.handle IS NOT DISTINCT FROM i.expected_handle AND a.handle_operation_id IS NULL
  ON CONFLICT (route, account_id, operation_id) DO NOTHING
  RETURNING route, account_id, operation_id
)
UPDATE access.account a
SET handle = i.handle, handle_operation_id = o.operation_id, transaction_id = i.transaction_id
FROM operation o, input i
WHERE a.route = i.route AND o.route = i.route AND a.account_id = o.account_id
RETURNING a.account_id;
