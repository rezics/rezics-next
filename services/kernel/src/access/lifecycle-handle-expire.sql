WITH input AS (SELECT :at::timestamptz AS at)
DELETE FROM access.handle_claim
USING input i
WHERE route = :route AND normalized_handle = :handle
  AND ((state = 'pending' AND hold_operation_id IS NULL AND expires_at <= i.at)
    OR (state = 'reserved' AND reserved_until <= i.at))
RETURNING normalized_handle;
