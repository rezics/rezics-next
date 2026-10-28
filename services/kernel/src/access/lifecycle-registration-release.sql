DELETE FROM access.handle_claim
WHERE route = :route AND normalized_handle = :handle AND account_id = :account_id
  AND reservation_id = :reservation_id AND hold_operation_id IS NULL AND former_until IS NULL
  AND state IN ('pending', 'active')
RETURNING normalized_handle;
