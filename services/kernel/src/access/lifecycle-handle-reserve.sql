WITH input AS (SELECT :at::timestamptz AS at)
INSERT INTO access.handle_claim (route, normalized_handle, account_id, state, expires_at, transaction_id, reservation_id)
VALUES (:route, :handle, :account_id, 'pending', :expires_at::timestamptz, :transaction_id, :reservation_id)
ON CONFLICT (route, normalized_handle) DO UPDATE
SET account_id = EXCLUDED.account_id, state = 'pending', expires_at = EXCLUDED.expires_at,
    reserved_until = NULL, transaction_id = EXCLUDED.transaction_id, reservation_id = EXCLUDED.reservation_id,
    hold_operation_id = NULL, hold_expected_handle = NULL
WHERE (access.handle_claim.state = 'pending' AND access.handle_claim.hold_operation_id IS NULL
       AND access.handle_claim.expires_at <= (SELECT at FROM input)
       AND (access.handle_claim.former_until IS NULL OR access.handle_claim.account_id = EXCLUDED.account_id))
   OR (access.handle_claim.state = 'reserved' AND access.handle_claim.account_id = EXCLUDED.account_id)
RETURNING normalized_handle;
