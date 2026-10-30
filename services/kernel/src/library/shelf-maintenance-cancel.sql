UPDATE library.shelf_maintenance_run SET cancelled=true,enqueue_pending=false,cursor='[]'::jsonb WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid;
