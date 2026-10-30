INSERT INTO library.shelf_maintenance_step(route,account_id,run_id,epoch,sequence,segment,phase,cursor,build_generation)
 SELECT route,account_id,run_id,epoch,sequence,segment,phase,cursor,build_generation FROM library.shelf_maintenance_run
 WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid ON CONFLICT DO NOTHING;
