INSERT INTO library.fact_source_head (route, account_id, generation)
VALUES (:route::integer, :account_id::uuid, 1)
ON CONFLICT (route, account_id) DO NOTHING;
