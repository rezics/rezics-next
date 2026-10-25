DELETE FROM access.handle_claim
WHERE route = :route AND normalized_handle = :handle AND account_id = :account_id
  AND reservation_id = :reservation_id AND hold_operation_id = :operation_id AND state = 'pending'
RETURNING normalized_handle;
