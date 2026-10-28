WITH input AS (
  SELECT :at::timestamptz AS at, :route::integer AS route, :handle::text AS handle,
         :transaction_id::uuid AS transaction_id
),
restored AS (
  UPDATE access.handle_claim h
  SET state = 'reserved', expires_at = NULL, reserved_until = former_until, transaction_id = i.transaction_id
  FROM input i
  WHERE h.route = i.route AND h.normalized_handle = i.handle
    AND h.state = 'pending' AND h.former_until IS NOT NULL
    AND h.hold_operation_id IS NULL AND h.expires_at <= i.at
  RETURNING h.normalized_handle
),
released AS (
  DELETE FROM access.handle_claim h
  USING input i
  WHERE h.route = i.route AND h.normalized_handle = i.handle
    AND h.state = 'pending' AND h.former_until IS NULL
    AND h.hold_operation_id IS NULL AND h.expires_at <= i.at
  RETURNING h.normalized_handle
)
SELECT normalized_handle FROM restored
UNION ALL
SELECT normalized_handle FROM released;
