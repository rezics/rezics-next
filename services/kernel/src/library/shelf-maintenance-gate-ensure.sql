INSERT INTO library.shelf_maintenance(route,account_id) VALUES(:route::integer,:account_id::uuid) ON CONFLICT DO NOTHING;
