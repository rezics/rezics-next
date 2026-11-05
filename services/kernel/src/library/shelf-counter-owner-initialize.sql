INSERT INTO library.shelf_writer_owner(route, account_id, fence_id, state)
VALUES (:route::integer, :account_id::uuid, :fence_id::uuid, 'initializing')
ON CONFLICT (route, account_id) DO NOTHING;
