-- Create or lock exactly one checkpoint. The caller has read the committed obligation first.
INSERT INTO access.erasure_progress (route, account_id, store, role, partition_no)
VALUES (:route::integer, :account_id::uuid, :store::text, :role::text, :partition_no::integer)
ON CONFLICT (route, account_id, store, role) DO UPDATE SET store = EXCLUDED.store
RETURNING partition_no, cursor, state, last_page, result;
