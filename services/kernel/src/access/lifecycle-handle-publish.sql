WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :operation_id::text AS operation_id,
         :handle::text AS handle, :reservation_id::uuid AS reservation_id,
         NULLIF(:expected_handle::text, '') AS expected_handle,
         NULLIF(:old_reservation_id::text, '')::uuid AS old_reservation_id, :transaction_id::uuid AS transaction_id,
         :at::timestamptz AS at, :handle_change_limit::integer AS handle_change_limit,
         :handle_change_window_ms::bigint AS handle_change_window_ms
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
SET handle = i.handle, handle_operation_id = o.operation_id,
    handle_change_times = CASE WHEN i.expected_handle IS NULL THEN a.handle_change_times ELSE (
      SELECT COALESCE(array_agg(recent.changed_at ORDER BY recent.changed_at), '{}'::timestamptz[])
      FROM (
        SELECT changed_at
        FROM unnest(a.handle_change_times || ARRAY[i.at]) AS change(changed_at)
        ORDER BY changed_at DESC
        LIMIT 5
      ) recent
    ) END,
    transaction_id = i.transaction_id
FROM operation o, input i
WHERE a.route = i.route AND o.route = i.route AND a.account_id = o.account_id
  AND (i.expected_handle IS NULL OR cardinality(a.handle_change_times) < i.handle_change_limit
       OR a.handle_change_times[1] <= i.at - i.handle_change_window_ms * INTERVAL '1 millisecond')
RETURNING a.account_id;
