INSERT INTO library.shelf_maintenance_session(route,account_id,run_id,session_id,last_changed_at)
 VALUES(:route::integer,:account_id::uuid,:run_id::uuid,:session_id::uuid,:time::nullable(timestamptz))
 ON CONFLICT(route,account_id,run_id,session_id) DO UPDATE SET last_changed_at=GREATEST(shelf_maintenance_session.last_changed_at,EXCLUDED.last_changed_at);
