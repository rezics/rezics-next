WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :transaction_id::uuid AS transaction_id), operation AS (
  UPDATE access.lifecycle_handle_operation o
  SET state = 'completed', transaction_id = i.transaction_id
  FROM input i
  WHERE o.route = i.route AND account_id = :account_id AND operation_id = :operation_id AND state = 'published'
    AND handle = :handle AND reservation_id = :reservation_id
    AND expected_handle IS NOT DISTINCT FROM NULLIF(:expected_handle::text, '')
  RETURNING o.route, o.account_id, o.operation_id
)
UPDATE access.account a SET handle_operation_id = NULL, transaction_id = i.transaction_id
FROM operation o, input i
WHERE a.route = i.route AND o.route = i.route AND a.account_id = o.account_id AND a.handle_operation_id = o.operation_id
RETURNING a.account_id;
