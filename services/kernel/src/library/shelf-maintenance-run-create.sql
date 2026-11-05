INSERT INTO library.shelf_maintenance_run(route,account_id,run_id,epoch,kind,phase,build_generation)
 VALUES(:route::integer,:account_id::uuid,:run_id::uuid,:epoch::bigint,:kind::text,:phase::text,:build_generation::nullable(uuid));
