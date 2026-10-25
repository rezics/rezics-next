WITH args AS (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :target_id::uuid AS target_id,
         :target_type::text AS target_type,
         :state::text AS state,
         :reason::text AS reason,
         :time::timestamptz AS time,
         :transaction_id::uuid AS transaction_id,
         :intent::text AS intent
)
INSERT INTO library.follow (
  route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id
) SELECT route, account_id, target_id, target_type, state, reason, time, time, transaction_id
  FROM args
ON CONFLICT (route, account_id, target_id) DO UPDATE
SET target_type = EXCLUDED.target_type,
    state = EXCLUDED.state,
    reason = EXCLUDED.reason,
    updated_at = EXCLUDED.updated_at,
    transaction_id = EXCLUDED.transaction_id
WHERE library.follow.target_type IS DISTINCT FROM EXCLUDED.target_type
   OR (
     (SELECT intent FROM args) <> 'implied'
     AND (library.follow.state, library.follow.reason)
         IS DISTINCT FROM (EXCLUDED.state, EXCLUDED.reason)
   )
RETURNING true AS changed;
