INSERT INTO commerce.erasure_progress (route, account_id, had_data)
VALUES (:route::integer, :account_id::uuid, :had_data::boolean)
ON CONFLICT (route, account_id) DO NOTHING;
