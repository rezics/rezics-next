WITH input AS (SELECT :state::text AS state)
UPDATE access.handle_claim
SET state = i.state, expires_at = NULL, reserved_until = NULLIF(:reserved_until::text, '')::timestamptz, transaction_id = :transaction_id
FROM input i
WHERE route = :route AND normalized_handle = :handle AND account_id = :account_id
  AND ((i.state = 'active' AND access.handle_claim.state = 'pending' AND reservation_id = NULLIF(:reservation_id::text, '')::uuid AND expires_at > :at::timestamptz)
    OR (i.state = 'reserved' AND access.handle_claim.state = 'active'))
RETURNING normalized_handle;
