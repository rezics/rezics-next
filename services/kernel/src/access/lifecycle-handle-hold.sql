UPDATE access.handle_claim
SET hold_operation_id = :operation_id, hold_expected_handle = NULLIF(:expected_handle::text, ''),
    transaction_id = :transaction_id
WHERE route = :route AND normalized_handle = :handle AND account_id = :account_id
  AND reservation_id = :reservation_id AND state = 'pending'
  AND expires_at > :at::timestamptz AND hold_operation_id IS NULL
RETURNING normalized_handle;
